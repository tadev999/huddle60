#!/usr/bin/env bash
# Deploys the AI-DLC planner to Cloud Run with Cloud Tasks and Firestore.
# Review every step before running it against a real project; it creates billable resources.
set -euo pipefail

: "${GCP_PROJECT:?Set GCP_PROJECT}"
: "${GCP_REGION:=asia-southeast1}"
: "${SERVICE:=ai-dlc-planner}"
: "${QUEUE:=ai-dlc-planner}"
: "${GITHUB_APP_ID:?Set GITHUB_APP_ID}"
: "${AI_DLC_MODEL:=gemini-2.5-flash}"

SA="${SERVICE}@${GCP_PROJECT}.iam.gserviceaccount.com"
gcloud config set project "$GCP_PROJECT"

echo "==> Enabling APIs"
gcloud services enable run.googleapis.com cloudtasks.googleapis.com firestore.googleapis.com \
  secretmanager.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

echo "==> Service account"
gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$SERVICE" --display-name "AI-DLC planner"
for role in roles/datastore.user roles/cloudtasks.enqueuer roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$GCP_PROJECT" --member "serviceAccount:$SA" --role "$role" --condition=None >/dev/null
done

echo "==> Firestore (native mode) and TTL policies"
gcloud firestore databases describe --database="(default)" >/dev/null 2>&1 ||
  gcloud firestore databases create --location="$GCP_REGION" --type=firestore-native
for group in ai-dlc-deliveries ai-dlc-plans ai-dlc-leases; do
  gcloud firestore fields ttls update expireAt --collection-group="$group" --enable-ttl --async || true
done

echo "==> Cloud Tasks queue"
gcloud tasks queues describe "$QUEUE" --location "$GCP_REGION" >/dev/null 2>&1 ||
  gcloud tasks queues create "$QUEUE" --location "$GCP_REGION" \
    --max-attempts=5 --min-backoff=10s --max-backoff=300s --max-concurrent-dispatches=5

echo "==> Secrets (values are read from files or generated; nothing is echoed)"
create_secret() {
  local name="$1" source="$2"
  if ! gcloud secrets describe "$name" >/dev/null 2>&1; then
    gcloud secrets create "$name" --replication-policy=automatic
  fi
  gcloud secrets versions add "$name" --data-file="$source" >/dev/null
}
: "${GITHUB_APP_PRIVATE_KEY_FILE:?Set GITHUB_APP_PRIVATE_KEY_FILE to the downloaded .pem}"
: "${GEMINI_API_KEY_FILE:?Set GEMINI_API_KEY_FILE to a file containing the Gemini API key}"
umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
openssl rand -hex 32 | tr -d '\n' >"$tmp/webhook"
openssl rand -hex 32 | tr -d '\n' >"$tmp/task"
create_secret ai-dlc-github-app-key "$GITHUB_APP_PRIVATE_KEY_FILE"
create_secret ai-dlc-gemini-api-key "$GEMINI_API_KEY_FILE"
gcloud secrets describe ai-dlc-webhook-secret >/dev/null 2>&1 || create_secret ai-dlc-webhook-secret "$tmp/webhook"
gcloud secrets describe ai-dlc-task-token >/dev/null 2>&1 || create_secret ai-dlc-task-token "$tmp/task"

echo "==> Deploying Cloud Run service"
SECRETS="GITHUB_APP_PRIVATE_KEY=ai-dlc-github-app-key:latest,GEMINI_API_KEY=ai-dlc-gemini-api-key:latest"
SECRETS+=",GITHUB_WEBHOOK_SECRET=ai-dlc-webhook-secret:latest,AI_DLC_TASK_TOKEN=ai-dlc-task-token:latest"
ENV="GITHUB_APP_ID=${GITHUB_APP_ID},AI_DLC_MODEL=${AI_DLC_MODEL},AI_DLC_STORE=firestore,AI_DLC_QUEUE=cloud-tasks"
ENV+=",GCP_PROJECT=${GCP_PROJECT},GCP_LOCATION=${GCP_REGION},CLOUD_TASKS_QUEUE=${QUEUE}"
deploy() {
  gcloud run deploy "$SERVICE" --source . --region "$GCP_REGION" --service-account "$SA" \
    --allow-unauthenticated --min-instances 0 --max-instances 3 --concurrency 20 --timeout 300 \
    --set-secrets "$SECRETS" --set-env-vars "$1"
}
# The worker URL is the service's own URL, which exists only after the first deploy.
URL="$(gcloud run services describe "$SERVICE" --region "$GCP_REGION" --format='value(status.url)' 2>/dev/null || true)"
if [[ -z "$URL" ]]; then
  deploy "${ENV},AI_DLC_WORKER_URL=https://placeholder.invalid/tasks/planner"
  URL="$(gcloud run services describe "$SERVICE" --region "$GCP_REGION" --format='value(status.url)')"
fi
deploy "${ENV},AI_DLC_WORKER_URL=${URL}/tasks/planner"

echo
echo "Done. Configure your GitHub App:"
echo "  Webhook URL:    ${URL}/webhook"
echo "  Webhook secret: gcloud secrets versions access latest --secret ai-dlc-webhook-secret"
echo "  Events:         Issues, Issue comment"
