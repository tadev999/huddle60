# AI-DLC trên GitHub: Tài liệu kỹ thuật triển khai

| Thuộc tính | Nội dung |
|---|---|
| Tài liệu gốc | [Đặc tả workflow](../webapp_quanly.md) |
| Mục đích | Chốt phương án tham chiếu đủ chi tiết để bắt đầu viết code, cấu hình và test |
| Trạng thái | Reference implementation alpha có trong `src/` (xem [README](../README.md)). Chế độ mặc định: **local app `huddle60 ui` + GitHub Actions** (mục 6.10); planner service trên Cloud Run là tùy chọn. Code là nguồn chính xác khi có khác biệt với tài liệu; reconciler, stale detector chủ động và merge queue chưa triển khai |
| Người đọc | Developer, maintainer, người cấu hình GitHub Organization/repository |

Đặc tả gốc mô tả nguyên tắc và để mở các quyết định ADR-01 đến ADR-06. Tài liệu
này chọn một **phương án mặc định** cho từng quyết định để nhóm có thể bắt đầu.
Mỗi lựa chọn có thể thay bằng ADR được review; khi thay, cập nhật tài liệu này
cùng PR. Mọi đoạn YAML, JSON, lệnh và đường dẫn là thiết kế cần xây dựng, không
phải mô tả hệ thống đang chạy.

Các mục đánh dấu **Cần kiểm chứng** phụ thuộc vào gói GitHub, quyền Organization
hoặc tính năng có thể thay đổi. Phải thử trên repository kiểm thử trước khi dựa
vào chúng; nếu không đáp ứng, dùng phương án dự phòng được nêu cùng mục.

## 1. Phạm vi triển khai

### 1.1 Thành phần cần xây

| Thành phần | Mô tả | Đặc tả gốc |
|---|---|---|
| Local app (`huddle60 ui`) | App chạy trên máy PO/DEV tại `127.0.0.1`: soạn kế hoạch với Gemini, tạo cây Issues, nút approve/ready/accept, context cho agent (mục 6.10) | Mục 7.2, 10.1 |
| Request Issue và Gemini planner | Nhận yêu cầu tự nhiên; hỏi làm rõ, đề xuất cây Epic/Story/Task; tạo Issues sau PO confirmation. Chạy trong local app hoặc planner service tùy chọn | Mục 7.2, 10.1 |
| Cấu hình repository | Issue forms, labels, PR template, CODEOWNERS, rulesets, Project fields | Mục 4, 5 |
| Policy file | Role PO/DEV theo GitHub user ID, Project mapping, risk paths, CI allowlist | Mục 3, 9 |
| Evidence store | Branch được bảo vệ chứa snapshot baseline, decision receipt và revocation | Mục 6.2 |
| Command handler | Xử lý `/ai-dlc` trên Issue: baseline, approve, ready, accept, revoke | Mục 6.3, 13.1 |
| GitHub App webhook service (tùy chọn) | Xác minh webhook, định tuyến plan/refine/confirm, gọi Gemini API và cập nhật Issue; chỉ cần khi PO muốn làm hoàn toàn bằng lệnh trên GitHub | Mục 7.2, 10.1 |
| Plan store/creation ledger | Lưu plan draft/hash có TTL, delivery deduplication và tiến độ tạo từng Issue | Mục 10.1, 11 |
| PR checks | `ai-dlc/baseline` (bắt buộc) và `ai-dlc/trace` | Mục 13.3 |
| Stale detector | Phát hiện Issue bị sửa sau khi chốt baseline, cập nhật status PR liên quan | Mục 6.4 |
| Evidence report | Ánh xạ test có tag AC sang kết quả CI đúng commit | Mục 8.1 |
| Reconciler | Đối soát Issue đóng thiếu acceptance, receipt mất hiệu lực, event bị lỡ | Mục 5, 12.3 |
| Agent context CLI | Xuất baseline đã chốt thành ngữ cảnh cho AI agent và khối trace cho PR | Mục 7.3 |
| Agent instructions | `AGENTS.md` và hướng dẫn cho công cụ AI được chọn | Mục 7.2 |

### 1.2 Ranh giới sản phẩm

Không xây webapp quản lý được host, board/backlog thứ hai, coding IDE, execution
runner hoặc đồng bộ Jira. Local app `huddle60 ui` không phải webapp được host: nó
chạy trên máy người dùng, không có database, dùng token GitHub của chính người
dùng và chỉ là lối tắt cho các thao tác vốn làm được trên GitHub (tạo Issue,
đăng comment `/ai-dlc`). GitHub Issues/Projects và evidence branch vẫn là nguồn
chuẩn. DEV tiếp tục dùng agent trong IDE riêng.

Không gọi model trong GitHub Actions có quyền ghi/secret. Model call chạy trong
local app (key của PO) hoặc planner service tùy chọn; Actions xử lý baseline,
approval receipt, PR checks và reconcile bằng logic xác định. AI không được cấp
tool để tự gọi API tạo Issue; model chỉ trả plan theo schema, code mới thực
hiện thao tác sau kiểm tra role và PO confirmation.

### 1.3 Lựa chọn mặc định cho các ADR

| ADR | Lựa chọn mặc định | Lý do |
|---|---|---|
| ADR-01 | Một repository chứa Issues, code và automation; một Organization Project v2 làm nguồn Status/Priority | Ít quyền chéo repo nhất; Project v2 hỗ trợ field tùy biến |
| ADR-02 | Snapshot JSON, canonical hóa theo RFC 8785 (JCS), hash SHA-256, lưu ở branch `ai-dlc-evidence` | Hash xác định; lịch sử Git có thể bảo vệ bằng ruleset |
| ADR-03 | Comment command trên Issue; role theo numeric user ID trong policy file được CODEOWNERS bảo vệ | Không phụ thuộc giao diện riêng; ID không đổi khi đổi login |
| ADR-04 | Automation deterministic: TypeScript/Node.js 22 trong GitHub Actions; PO planner: cùng TypeScript codebase, chạy trong local app (mặc định) hoặc Cloud Run service (tùy chọn) | Không đưa model call/secret vào workflow chạy theo Issue/PR untrusted |
| ADR-05 | DEV dùng agent hiện có trong IDE, đọc baseline qua CLI hoặc nút context; PO dùng local app hoặc Issue/comment | PO có nút bấm mà không cần hạ tầng; hai context và quyền tách biệt |
| ADR-06 | Nghiệm thu trên run của workflow build chạy trên branch mặc định sau merge | Tránh nhầm PR head với commit tích hợp |
| ADR-07 | PO planner dùng GitHub App webhook → Cloud Tasks → Cloud Run; Firestore lưu dedupe/draft/creation ledger tối thiểu | Gemini call bất đồng bộ, retry bền vững; không lưu backlog hoặc Project trong DB |
| ADR-08 | Một Gemini API project/credential do tổ chức quản lý cho planner; DEV IDE dùng credential cá nhân/tổ chức riêng | Không dùng cookie đăng nhập hoặc chia sẻ ba tài khoản Gemini qua backend |
| ADR-09 | Chế độ mặc định là local app + Actions: app gọi Gemini, tạo Issues và đăng lệnh `/ai-dlc` bằng token của người dùng; Actions vẫn là bên duy nhất ghi evidence. ADR-07 thành tùy chọn | Không cần Cloud Run/Firestore/Cloud Tasks; không thêm logic tin cậy mới vì quyết định vẫn được Actions kiểm tra |

## 2. Cấu trúc repository

Cấu trúc thực tế của reference implementation:

```text
src/core/        Lõi thuần: canonical hash, policy, command, issue form, plan, baseline, decision, render
src/app/         Local app: LocalApp (plan, items, decisions), server.ts (HTTP + bảo vệ), start.ts (credential, khởi động)
ui/              Giao diện tĩnh của local app (HTML/CSS/JS thuần, không build step)
src/planner/     prompt, generatePlan, IssueTreeCreator (ledger), PlannerService (dịch vụ tùy chọn)
src/workflow/    WorkflowService (baseline, approve, ready, accept, revoke, PR gate), context.ts (agent context)
src/adapters/    GitHub (Octokit), evidence branch, Gemini, Firestore, Cloud Tasks, in-memory
src/server/      HTTP của planner service: HMAC webhook, chống trùng delivery, worker
src/entry/       planner-server, action, cli (ui, init, context, init-evidence, validate-policy, plan-preview)
templates/       Issue forms, policy, workflow, PR template, AGENTS.md cho repository áp dụng
tests/           Unit + kịch bản đầu-cuối với FakeGitHub/FakeModel
```

Bố cục thiết kế ban đầu (giữ để tham chiếu; một số phần như reconciler, `ai-dlc/trace`
và schemas JSON chưa được xây):

```text
.github/
  ISSUE_TEMPLATE/
    epic.yml
    story.yml
    task.yml
    config.yml
  PULL_REQUEST_TEMPLATE.md
  CODEOWNERS
  ai-dlc/
    policy.yml
  workflows/
    ai-dlc-commands.yml
    ai-dlc-request.yml
    ai-dlc-pr-checks.yml
    ai-dlc-issue-edited.yml
    ai-dlc-reconcile.yml
    ci.yml
    build.yml
AGENTS.md
package.json
tsconfig.json
src/
  main.ts                  Điều phối theo GitHub event
  planner-server.ts        HTTP webhook service chạy trên Cloud Run
  core/
    canonical.ts           JCS + SHA-256
    issue-form.ts          Parse body của Issue form
    command.ts             Parse lệnh /ai-dlc
    policy.ts              Đọc và validate policy
    baseline.ts            Dựng payload baseline
    decision.ts            Tạo receipt và kiểm tra hiệu lực
    pr-block.ts            Parse khối AI-DLC trong PR body
    errors.ts              Mã lỗi
  github/
    client.ts              Octokit với retry/throttle
    issues.ts
    projects.ts            GraphQL Projects v2
    statuses.ts
    actions.ts             Xác minh workflow run
  store/
    evidence.ts            Đọc/ghi branch ai-dlc-evidence
  handlers/
    command-handler.ts
    pr-check.ts
    issue-edited.ts
    reconcile.ts
    planner-webhook.ts     Xác minh webhook và enqueue planner job
    plan-request.ts        Gọi Gemini, validate và lưu draft plan
    plan-confirm.ts        Xác minh PO/hash và tạo cây Issues
    plan-create.ts         Tạo/reconcile parent-child Issues idempotent
  planner/
    gemini-client.ts       Gemini API, timeout/quota/redaction
    plan-schema.ts         Schema, limits và semantic validation
    prompt.ts              Prompt/version và xử lý untrusted input
    github-comment.ts      Render plan/question/confirmation comment
  cloud/
    firestore-store.ts     Delivery, plan TTL và creation ledger
    tasks-queue.ts         Enqueue/retry công việc planner
  report/
    junit-ac.ts            Ánh xạ JUnit sang AC
  cli/
    context.ts             npm run ai-dlc:context
schemas/
  policy.schema.json
  baseline.schema.json
  decision.schema.json
  revocation.schema.json
  plan.schema.json
tests/
  unit/
  fixtures/                Payload GitHub đã khử dữ liệu nhạy cảm
  integration/             Repository/App kiểm thử, cần bật thủ công
  planner-evals/           Yêu cầu mẫu, kỳ vọng phân rã và Gemini evaluations
docs/
  technical-implementation.md
  adr/
infra/
  cloud-run/                 Service/queue/Firestore/IAM config theo môi trường
```

Code automation chỉ được chạy từ branch mặc định. Không chạy code của PR trong
workflow có quyền ghi hoặc có secret. Planner service chỉ xử lý webhook/plan
đã xác thực; không checkout hoặc chạy code PR. Thư mục `.github/`, `src/`,
`schemas/` và `infra/` cần CODEOWNERS maintainer vì các thay đổi ảnh hưởng gate,
quyền và chi phí.

## 3. Cấu hình GitHub

### 3.1 Labels

| Label | Ý nghĩa |
|---|---|
| `ai-dlc:request` | Issue yêu cầu tự nhiên; tạo Issue này khởi chạy planner nếu tác giả thuộc role PO |
| `ai-dlc:plan-draft` | Có bản phân rã Gemini đang chờ PO xác nhận |
| `ai-dlc:plan-created` | Cây Issues đã được tạo/đối soát từ một plan đã xác nhận |
| `ai-dlc:plan-partial` | Tạo cây lỗi một phần; cần reconcile/resume, không tạo lại mù |
| `type:epic`, `type:story`, `type:task` | Phân loại Issue; dùng khi Organization chưa bật issue types |
| `lane:fast`, `lane:standard`, `lane:strict` | Luồng rủi ro AI đề xuất; quyết định chính thức nằm trong ready receipt |
| `ai-dlc:needs-acceptance` | Reconciler gắn khi Story/Epic bị đóng mà thiếu acceptance hợp lệ |
| `ai-dlc:stale` | Stale detector gắn khi Issue bị sửa sau baseline đã duyệt |

Label chỉ để hiển thị và lọc. Không gate nào đọc label để cấp quyền; gate đọc
receipt trong evidence store. `huddle60 init` tạo các label đang được code dùng
(`ai-dlc:*`, `type:*`) cùng evidence branch; `lane:*` và `ai-dlc:needs-acceptance`
chưa được dùng trong bản alpha.

### 3.2 Issue forms

Parser dựa vào heading `### <label>` mà GitHub sinh ra khi render Issue form.
Vì vậy `label` của từng trường là một phần của contract: đổi label là breaking
change cho parser và cần tăng `schemaVersion` của baseline.

`.github/ISSUE_TEMPLATE/story.yml`:

```yaml
name: Story
description: Một phần giá trị sử dụng có thể nghiệm thu
title: "[Story] "
labels: ["type:story"]
body:
  - type: textarea
    id: goal
    attributes:
      label: Mục tiêu và người dùng
      description: Vấn đề, người dùng và cách đo kết quả
    validations:
      required: true
  - type: textarea
    id: scope
    attributes:
      label: Phạm vi
      value: |
        - Trong phạm vi:
        - Ngoài phạm vi:
        - Business rules:
    validations:
      required: true
  - type: input
    id: parent
    attributes:
      label: Issue cha
      description: "Số Issue của Epic, ví dụ #10"
  - type: input
    id: blocked_by
    attributes:
      label: Blocked by
      description: "Danh sách Issue, phân cách bằng dấu phẩy, ví dụ #12, #13"
  - type: textarea
    id: acceptance_criteria
    attributes:
      label: Acceptance Criteria
      description: "Mỗi dòng một AC: - AC-01: Given ... When ... Then ..."
    validations:
      required: true
  - type: textarea
    id: technical_refs
    attributes:
      label: Tham chiếu kỹ thuật
      description: Đường dẫn tài liệu/contract kèm commit SHA
  - type: textarea
    id: risks
    attributes:
      label: Câu hỏi và rủi ro
```

`epic.yml` dùng cùng cấu trúc, thay `Acceptance Criteria` bằng
`Tiêu chí nghiệm thu Epic` (ID dạng `EC-01`) và thêm trường `Story bắt buộc`.
`task.yml` gồm `Story`, `AC liên quan`, `Đầu ra`, `Phạm vi file/module`,
`Kiểm chứng` và `Blocked by`. `config.yml` đặt `blank_issues_enabled: false`
để mọi Issue công việc đi qua form; bug và đề xuất có form riêng.

AC hợp lệ khớp biểu thức `^- (AC|EC)-\d{2,3}: .+$`. ID không được trùng trong
một Issue và không được tái sử dụng cho nội dung khác sau khi baseline đã chốt.

### 3.2.1 Request Issue: một yêu cầu đầu vào

PO tạo Issue bằng template `request.yml`, nhập yêu cầu tự nhiên vào một trường
bắt buộc. Tạo Issue với label `ai-dlc:request` gửi `issues.opened` tới App;
PO không cần vào IDE, cài extension, tạo trước Epic/Story/Task hay tự phân loại
request. Tác giả phải có numeric user ID trong role `po`; request của người
khác không tự gọi model hoặc tiêu thụ quota.

```yaml
name: AI-DLC Request
description: Nhập yêu cầu; AI đề xuất cây công việc để PO xác nhận
title: "[Request] "
labels: ["ai-dlc:request"]
body:
  - type: textarea
    id: request
    attributes:
      label: Yêu cầu
      description: Mô tả kết quả mong muốn bằng ngôn ngữ tự nhiên
      placeholder: "Lập trình login sử dụng Firebase"
    validations:
      required: true
```

Form là giao diện nhập của PO; App đăng câu hỏi, draft, xác nhận và kết quả
ngay trong Issue comments. Không tạo webapp chat. Issue gốc là request/source
record; các Epic/Story/Task được tạo đều liên kết ngược tới Issue gốc.

Khi cần làm rõ, PO trả lời bằng comment bắt đầu với `/ai-dlc refine plan=<planId>`.
Sau khi xem draft, PO xác nhận bằng `/ai-dlc create-plan plan=<planId> hash=<planHash>`.
Command chỉ xử lý từ comment mới của human actor; nội dung trong quote/code
block, comment bot hoặc comment đã sửa không được thực thi. Thay đổi Issue body
sau khi tạo draft làm plan stale và cần chạy lại trước confirmation.

### 3.3 Project v2

Tạo một Organization Project với các field:

| Field | Loại | Giá trị |
|---|---|---|
| Status | Single select | Backlog, Refinement, Ready, In Progress, Technical Review, Acceptance, Done |
| Priority | Single select | P0, P1, P2, P3 |
| Lane | Single select | Fast, Standard, Strict |

**Bắt buộc** tắt built-in workflow của Project "Pull request merged → Done" và
"Item closed → Done" cho Story/Epic, vì chúng chuyển Done mà không có nghiệm
thu. Có thể giữ "Item added → Backlog". Automation chỉ ghi Status ở các thời
điểm nêu tại mục 6; người dùng vẫn kéo card bình thường ở các trạng thái khác.

### 3.4 Rulesets và bảo vệ

Branch mặc định:

- Yêu cầu PR, ít nhất một approval, dismiss approval cũ khi có commit mới.
- Yêu cầu review từ CODEOWNERS.
- Required status checks: CI kỹ thuật và `ai-dlc/baseline`, với nguồn phát giới
  hạn ở GitHub App của AI-DLC.
- Chặn force push và xóa branch.

Branch `ai-dlc-evidence`:

- Chặn force push, xóa branch và tạo lại branch.
- Giới hạn quyền update; chỉ GitHub App của AI-DLC nằm trong bypass list.

**Cần kiểm chứng:** ruleset cho phép đặt GitHub App làm bypass actor và giới hạn
nguồn của required status check theo gói đang dùng. Nếu không hỗ trợ, đặt
evidence store trong một repository riêng chỉ App có quyền ghi.

`.github/CODEOWNERS`:

```text
/.github/                @your-org/ai-dlc-maintainers
/src/                    @your-org/ai-dlc-maintainers
/schemas/                @your-org/ai-dlc-maintainers
/AGENTS.md               @your-org/ai-dlc-maintainers
```

### 3.5 GitHub App

Tạo GitHub App thuộc Organization và cài vào repository sản phẩm. Ở chế độ mặc
định (local app + Actions), App chỉ dùng để workflow mint installation token ghi
evidence, reply và commit status: **không cần webhook**. Chỉ bật webhook HTTPS khi
triển khai planner service tùy chọn. PO role vẫn xác định bằng numeric GitHub user
ID, không suy ra từ danh tính bot.

| Permission | Mức | Dùng cho |
|---|---|---|
| Repository: Contents | Read and write | Ghi branch `ai-dlc-evidence`, đọc policy |
| Repository: Issues | Read and write | Đọc Request, tạo Epic/Story/Task, comment, label và liên kết parent/child |
| Repository: Pull requests | Read | Đọc PR body và danh sách file |
| Repository: Commit statuses | Read and write | Ghi `ai-dlc/baseline`, `ai-dlc/trace` |
| Repository: Actions | Read | Xác minh workflow run khi nghiệm thu |
| Repository: Metadata | Read | Bắt buộc |
| Organization: Projects | Read and write | Thêm Issues đã xác nhận vào Project v2, cập nhật field theo policy |

Không cấp Administration, Workflows, Secrets hoặc Deployments write. Khi dùng
planner service, đăng ký webhook events tối thiểu `issues` (`opened`, `edited`, `labeled`, `closed`,
`reopened`) và `issue_comment` (`created`, `edited`, `deleted`). Webhook secret,
App private key và Gemini API key lưu riêng trong Secret Manager. Actions chỉ
mint installation token ngắn hạn; không chuyển private key vào planner container.

`GITHUB_TOKEN` không truy cập được Organization Project trong phương án này,
nên App dùng cho Project mutation. Hành động do App token thực hiện có thể kích
hoạt webhook/workflow khác; router bỏ qua bot event, trừ callback allowlist theo
plan/operation ID cần đối soát. Không bỏ qua mọi bot event trước khi xác định
callback cần thiết.

| Cấu hình | Nơi lưu | Quy tắc |
|---|---|---|
| `GITHUB_APP_ID` | Cloud Run env | Giá trị không bí mật |
| `GITHUB_WEBHOOK_SECRET` | Secret Manager | HMAC trên raw request body |
| `GITHUB_APP_PRIVATE_KEY` | Secret Manager | Chỉ component cần GitHub API; mint installation token ngắn hạn |
| `GEMINI_API_KEY` | Secret Manager | Credential dịch vụ do tổ chức quản lý, không phải cookie/login cá nhân |
| `AI_DLC_MODEL` | Cloud Run env | Model ID allowlist; pin version khi provider cho phép |
| `AI_DLC_ENABLED` | Cloud Run env | Kill switch cho model call và Issue creation |
| `GCP_PROJECT_ID`, `GCP_REGION` | Cloud Run env | Project/region được phép chạy service và queue |
| `CLOUD_TASKS_QUEUE` | Cloud Run env | Queue có retry/max-attempt đã cấu hình |
| `PLANNER_MAX_NODES`, `PLANNER_MAX_COST_USD`, `PLANNER_TTL_DAYS` | Cloud Run env | Giới hạn hữu hạn; không cho giá trị vô hạn/mặc định ngầm |

PO planner dùng một Gemini API project/credential do tổ chức quản lý. Ba tài
khoản Gemini của DEV không được backend dùng chung; mỗi DEV giữ danh tính và
credential riêng trong IDE. Usage được ghi theo plan ID/Issue/actor, không log
API key hoặc prompt thô.

## 4. Policy file

`.github/ai-dlc/policy.yml` được đọc từ branch mặc định tại thời điểm xử lý.
Thay đổi policy phải qua PR có CODEOWNERS review.

```yaml
version: 1
roles:
  po:
    - id: 1000001
      login: po-example
  dev:
    - id: 1000002
      login: dev-example
project:
  owner: your-org
  number: 3
  fields:
    status: Status
    lane: Lane
  status_options:
    ready: Ready
    in_progress: In Progress
    technical_review: Technical Review
    acceptance: Acceptance
    done: Done
lanes:
  fast:
    requires_po_approval: false
  standard:
    requires_po_approval: true
  strict:
    requires_po_approval: true
    requires_reviewers: ["@your-org/tech-leads"]
sensitive_paths:
  - "migrations/**"
  - "src/auth/**"
  - ".github/**"
evidence:
  branch: ai-dlc-evidence
acceptance:
  build_workflows:
    - .github/workflows/build.yml
reconcile:
  reopen_unaccepted_close: false
```

Quy tắc:

- Role xác định bằng `id`; `login` chỉ để đọc cho dễ. Handler so sánh
  `comment.user.id`, không so sánh login hoặc `author_association`.
- Một người có thể ở cả `po` và `dev`. Bot không được nằm trong role nào.
- PR chạm `sensitive_paths` không được dùng lane `fast`.
- `policy.schema.json` validate file; policy sai làm mọi handler dừng với lỗi
  `E_POLICY_INVALID` thay vì dùng giá trị mặc định.

## 5. Dữ liệu và hash

### 5.1 Canonical hóa

Hàm `contentHash(payload)`:

1. Xóa trường `contentHash` khỏi payload nếu có.
2. Chuẩn hóa mọi chuỗi văn bản: Unicode NFC, `\r\n` và `\r` thành `\n`, bỏ
   khoảng trắng cuối mỗi dòng, bỏ dòng trống ở đầu và cuối.
3. Serialize theo RFC 8785 (JCS).
4. Băm SHA-256, ghi dạng `sha256:<hex chữ thường>`.

Không đưa vào hash: Status/Priority, assignee, label, timestamp, comment, số
reaction. Chỉ nội dung nghiệp vụ làm thay đổi hash. Thay đổi bước 2 là breaking
change, phải tăng `canonicalVersion`.

### 5.2 Baseline snapshot

Đường dẫn: `baselines/<repoId>/<issueNumber>/<baselineId>.json`.
`baselineId` = `bl-<issueNumber>-<12 ký tự hex đầu của hash>`. Cùng nội dung
cho cùng ID, nên tạo lại baseline là idempotent.

```json
{
  "schemaVersion": 1,
  "canonicalVersion": 1,
  "baselineId": "bl-11-3f2a9c1d7e4b",
  "kind": "story",
  "source": {
    "repositoryId": 123456789,
    "issueNodeId": "I_kwDOexample",
    "issueNumber": 11
  },
  "requirements": {
    "title": "Nhân viên gửi yêu cầu nghỉ phép",
    "sections": {
      "Mục tiêu và người dùng": "Nhân viên gửi yêu cầu để quản lý xem xét",
      "Phạm vi": "- Trong phạm vi: tạo yêu cầu\n- Ngoài phạm vi: duyệt yêu cầu",
      "Acceptance Criteria": "- AC-01: Given ... When ... Then ...",
      "Tham chiếu kỹ thuật": "",
      "Câu hỏi và rủi ro": ""
    },
    "acceptanceCriteria": [
      { "id": "AC-01", "text": "Given ... When ... Then ..." }
    ]
  },
  "parent": 10,
  "blockedBy": [12],
  "contractRefs": [],
  "contentHash": "sha256:3f2a9c1d7e4b0000000000000000000000000000000000000000000000000000"
}
```

Các giá trị ID và hash ở trên là minh họa. Snapshot chỉ được tạo, không được
sửa; Issue tiếp tục là nơi chỉnh nội dung.

### 5.3 Decision receipt

Đường dẫn: `decisions/<repoId>/<issueNumber>/<decisionId>.json`.
`decisionId` = `dec-` + 16 ký tự hex đầu của SHA-256 của `kind:commentId`, nên
cùng comment không tạo hai receipt.

```json
{
  "schemaVersion": 1,
  "decisionId": "dec-9a8b7c6d5e4f3a2b",
  "kind": "approve",
  "baselineId": "bl-11-3f2a9c1d7e4b",
  "baselineHash": "sha256:3f2a9c1d7e4b0000000000000000000000000000000000000000000000000000",
  "actor": { "id": 1000001, "login": "po-example", "role": "po" },
  "source": {
    "commentId": 2000001,
    "commentBodyDigest": "sha256:1111111111111111111111111111111111111111111111111111111111111111"
  },
  "lane": null,
  "build": null,
  "policyCommitSha": "2222222222222222222222222222222222222222",
  "toolVersion": "0.1.0",
  "recordedAt": "2026-10-29T10:00:00Z"
}
```

`kind` thuộc `approve`, `ready` hoặc `accept`:

- `ready` bắt buộc có `lane`.
- `accept` bắt buộc có `build` gồm `runId`, `runAttempt`, `workflowPath` và
  `headSha`.
- `approve` và `ready` có `build` là `null`.

Revocation lưu tại `revocations/<repoId>/<issueNumber>/<decisionId>.json` gồm
decision bị thu hồi, actor, lý do và comment nguồn.

### 5.4 Kiểm tra hiệu lực receipt

Receipt chỉ hợp lệ khi **tất cả** điều kiện sau đúng tại thời điểm kiểm tra:

1. File receipt tồn tại và validate theo schema.
2. Không có revocation cho `decisionId`.
3. Comment nguồn còn tồn tại và digest body hiện tại bằng `commentBodyDigest`.
4. Actor vẫn thuộc role yêu cầu trong policy hiện tại.
5. Snapshot `baselineId` tồn tại và hash tính lại bằng `baselineHash`.
6. Với `accept`: workflow run vẫn tồn tại và thỏa mục 6.6.

Hiệu lực được tính lại mỗi khi dùng, không lưu cờ `valid` trong receipt. Nhờ
vậy sửa/xóa comment hoặc gỡ role làm receipt hết hiệu lực ngay ở lần kiểm tra
kế tiếp, kể cả khi event sửa/xóa bị lỡ.

## 6. Command handler

### 6.1 Cú pháp

Lệnh chỉ được nhận khi là **dòng đầu tiên** của comment trên Issue (không phải PR):

```text
/ai-dlc baseline
/ai-dlc approve baseline=<baselineId> hash=<contentHash>
/ai-dlc ready baseline=<baselineId> hash=<contentHash> lane=<fast|standard|strict>
/ai-dlc accept baseline=<baselineId> run=<runId> commit=<sha>
/ai-dlc revoke decision=<decisionId> reason="<lý do>"
/ai-dlc refine plan=<planId>
/ai-dlc create-plan plan=<planId> hash=<planHash>
/ai-dlc resume-plan plan=<planId>
```

Tham số dạng `key=value`, không có khoảng trắng trong value trừ khi đặt trong
dấu nháy kép. Tham số lạ, thiếu hoặc lặp làm lệnh bị từ chối. Comment của bot,
comment đã chỉnh sửa và lệnh trong code block hoặc quote không được xử lý như lệnh mới.

### 6.2 Quyền theo lệnh

| Lệnh | Role | Điều kiện |
|---|---|---|
| `baseline` | `po` hoặc `dev` | Issue là `type:epic`, `type:story` hoặc `type:task`; parse form thành công |
| `approve` | `po` | Hash khớp nội dung Issue hiện tại. Nếu baseline chưa được lưu nhưng id và hash trùng snapshot của nội dung hiện tại, handler lưu snapshot rồi ghi receipt (một lệnh là đủ) |
| `ready` | `dev` | Hash khớp (tự lưu snapshot như `approve`); lane hợp lệ; nếu lane yêu cầu thì đã có `approve` hợp lệ (Task kế thừa approve của Story cha cho nội dung hiện tại); mọi Issue `blockedBy` đã đóng với `state_reason=completed` |
| `accept` (bổ sung) | `po` | Chỉ cho Story/Epic (`E_WRONG_KIND` với Task); baseline phải đã được lưu |
| `accept` | `po` | Có `ready` hợp lệ cho baseline; run thỏa mục 6.6 |
| `revoke` | Người tạo decision, hoặc `po` cho decision nghiệp vụ, `dev` cho `ready` | Decision tồn tại và chưa bị thu hồi |
| `refine` | `po` | Plan thuộc Request Issue, Issue body chưa đổi ngoài thông tin làm rõ được ghi nhận; quota/limit hợp lệ |
| `create-plan` | `po` | Plan hash khớp draft mới nhất, Request Issue digest chưa stale, plan chưa tạo hoặc đã có creation ledger để resume |
| `resume-plan` | `po` hoặc maintainer | Creation ledger cùng plan/hash tồn tại ở trạng thái partial/failed; không thay plan |

### 6.3 Luồng xử lý chung

1. Bỏ qua nếu Issue là PR. Bỏ bot event trừ callback allowlist có operation ID
  do planner/App tạo và cần reconcile; không dùng event bot làm human decision.
2. Với `issues.opened` có label `ai-dlc:request`, kiểm tra tác giả là PO; tạo
  planner job theo delivery ID và trả `202`. Không chạy model trong Action.
3. Với comment, route plan commands sang planner service và baseline/approval/
  acceptance commands sang deterministic handler; reject command không rõ loại.
4. Đọc policy từ branch mặc định; validate.
5. Parse lệnh; sai cú pháp thì trả lời lỗi và dừng.
6. Kiểm tra role theo numeric `comment.user.id` hoặc `issue.user.id`.
7. Đọc lại Issue qua API, không dùng body trong webhook làm nguồn chuẩn.
8. Thực hiện kiểm tra theo bảng 6.2.
9. Ghi file vào evidence store (mục 7). Nếu file cùng đường dẫn đã có nội dung
   giống hệt thì coi là đã xử lý; nếu khác thì báo `E_CONFLICT`, không ghi đè.
10. Cập nhật Project Status và label nếu lệnh yêu cầu.
11. Trả lời bằng một comment duy nhất có marker
   `<!-- ai-dlc:reply:<commentId> -->`; khi retry thì sửa comment đó thay vì tạo mới.

### 6.4 Kết quả từng lệnh

| Lệnh | Ghi evidence | Project Status | Phản hồi |
|---|---|---|---|
| `baseline` (tùy chọn) | Snapshot | Giữ nguyên | ID, hash, danh sách AC, lệnh approve/ready mẫu |
| `approve` | Receipt `approve` | Giữ nguyên | Xác nhận, nhắc DEV chạy `ready` |
| `ready` | Receipt `ready` | Ready; Lane theo lệnh | Xác nhận, khối PR mẫu cho agent |
| `accept` | Receipt `accept` | Done | Xác nhận, đóng Issue với `state_reason=completed` |
| `revoke` | Revocation | Ready → Refinement hoặc Done → Acceptance | Liệt kê PR/Issue bị ảnh hưởng |
| Request Issue | Draft plan + plan hash trong comment | Request ở Refinement | Cây Epic/Story/Task dự kiến, giả định và câu hỏi mở |
| `refine` | Revision plan mới, plan cũ superseded | Refinement | Diff của plan mới và câu hỏi còn mở |
| `create-plan` | Creation ledger và mapping Issue ID | Tạo Issues ở Backlog/Refinement | Link cây Issues hoặc partial failure/resume hướng dẫn |
| `resume-plan` | Cập nhật cùng creation ledger | Không nâng trạng thái | Các Issue đã có và phần còn lại |

### 6.5 Mã lỗi

| Mã | Nghĩa |
|---|---|
| `E_POLICY_INVALID` | Policy không hợp lệ hoặc không đọc được |
| `E_SYNTAX` | Lệnh sai cú pháp |
| `E_ROLE` | Người ra lệnh không có role yêu cầu |
| `E_FORM` | Không parse được Issue form hoặc AC |
| `E_HASH_MISMATCH` | Hash trong lệnh khác nội dung Issue hiện tại |
| `E_BASELINE_NOT_FOUND` | Không có snapshot với ID đã cho |
| `E_NOT_APPROVED` | Lane yêu cầu PO approval nhưng chưa có receipt hợp lệ |
| `E_NOT_READY` | Chưa có ready receipt hợp lệ |
| `E_DEPENDENCY_OPEN` | Có Issue blocked-by chưa hoàn tất |
| `E_BUILD_INVALID` | Workflow run không thỏa điều kiện nghiệm thu |
| `E_CONFLICT` | Evidence đã có nội dung khác cho cùng ID |
| `E_GITHUB_API` | Lỗi API sau khi đã retry; trạng thái không được nâng |
| `E_GEMINI` | Model timeout/provider error; không có Issue creation side effect |
| `E_PLAN_SCHEMA` | Plan không hợp lệ theo schema/semantic rules |
| `E_PLAN_STALE` | Request digest hoặc plan revision thay đổi sau draft |
| `E_PLAN_LIMIT` | Node/token/cost/time limit bị vượt |
| `E_PLAN_PARTIAL` | Một phần cây đã tạo; resume cùng plan/hash sau reconcile |
| `E_PLANNER_DISABLED` | Kill switch tắt planner |
| `E_WRONG_KIND` | Lệnh không áp dụng cho loại Issue này (ví dụ `accept` một Task) |
| `E_CONFIG` | Local app thiếu cấu hình (GitHub token, Gemini key) |

### 6.6 Điều kiện build khi nghiệm thu

Handler gọi `GET /repos/{owner}/{repo}/actions/runs/{runId}` và yêu cầu:

- `repository.id` bằng repository hiện tại.
- `path` nằm trong `acceptance.build_workflows` của policy.
- `event` là `push` và `head_branch` là branch mặc định.
- `head_sha` bằng tham số `commit`.
- `status` là `completed` và `conclusion` là `success`.

Lưu `runAttempt` vào receipt. Nếu sau này cần nghiệm thu trước merge, phải viết
ADR mới; phương án này không hỗ trợ.

### 6.7 Workflow

`.github/workflows/ai-dlc-commands.yml`:

```yaml
name: ai-dlc-commands
on:
  issue_comment:
    types: [created, edited, deleted]
permissions: {}
jobs:
  handle:
    if: >-
      github.event.issue.pull_request == null &&
      github.event.sender.type != 'Bot' &&
      (startsWith(github.event.comment.body, '/ai-dlc') ||
       (github.event.action == 'edited' &&
        startsWith(github.event.changes.body.from, '/ai-dlc')))
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.repository.default_branch }}
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ vars.AI_DLC_APP_ID }}
          private-key: ${{ secrets.AI_DLC_APP_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
      - run: node dist/main.js command
        env:
          AI_DLC_TOKEN: ${{ steps.app-token.outputs.token }}
```

Khi triển khai, ghim mọi action theo commit SHA đầy đủ thay vì tag. Không bao giờ
đưa `github.event.comment.body` vào `run:`; handler đọc payload từ
`GITHUB_EVENT_PATH`. Với `edited` và `deleted`, handler không thực thi lệnh mà
chỉ tìm receipt có `commentId` tương ứng để báo mất hiệu lực.

Không dùng `concurrency` cho workflow này: GitHub chỉ giữ một job chờ cho mỗi
group và hủy job chờ cũ hơn, nên có thể làm mất lệnh. An toàn đồng thời dựa vào
ID xác định, ghi idempotent và retry khi push bị từ chối (mục 7).

Workflow Action chỉ xử lý deterministic commands. `refine`, `create-plan` và
`resume-plan` được route sang App planner; handler Action nhận diện và bỏ qua
các lệnh này, không ghi lỗi/comment và không gọi Gemini. App webhook kiểm tra
delivery/event trước khi enqueue, không chạy model trực tiếp trong request HTTP.

### 6.8 PO planner: từ một câu tới cây Issues

#### Luồng yêu cầu

```text
PO tạo Request Issue với một câu yêu cầu
→ App xác minh repo, label, PO role và quota; lưu delivery ID
→ Cloud Tasks gọi planner worker
→ Worker đọc lại Issue và policy; gửi context tối thiểu cho Gemini
→ Gemini trả JSON plan; validator kiểm tra schema, hierarchy, AC và limits
→ App lưu planId/hash/TTL và comment draft + câu hỏi dưới Request Issue
→ PO trả lời /ai-dlc refine plan=<planId> nếu cần, hoặc xem draft và xác nhận
→ App kiểm tra PO role, request digest, planHash và confirmation event
→ Creation worker tạo Issues parent-first, liên kết parent/dependency, thêm Project
→ App comment kết quả/partial failure và lưu mapping localId → GitHub Issue ID
```

Tạo Request Issue là một lần nhập đầu vào. Nếu plan có câu hỏi chặn, PO trả lời
trong cùng Issue rồi yêu cầu refine; không bắt PO tự điền từng Issue form. Không
phát sinh Issues cho tới confirmation command gắn plan ID/hash. Planner không có
tool gọi GitHub API; chỉ creation worker sau authorization mới được ghi.

#### Plan output contract

Gemini phải trả đúng JSON theo schema có version, không Markdown trong payload:

```json
{
  "schemaVersion": 1,
  "planId": "plan-example-001",
  "source": {
    "repositoryId": 123456789,
    "issueNodeId": "I_kwDOexample",
    "issueNumber": 50,
    "requestDigest": "sha256:example"
  },
  "rootKind": "epic",
  "assumptions": ["Xác thực dành cho ứng dụng web hiện có"],
  "openQuestions": ["Có cần đăng nhập bằng Google không?"],
  "nodes": [
    {
      "localId": "epic-auth",
      "kind": "epic",
      "parentLocalId": null,
      "title": "Xác thực người dùng",
      "goal": "Người dùng truy cập ứng dụng theo danh tính đã xác thực",
      "scope": ["Các luồng xác thực đã được PO chốt"],
      "epicCriteria": [
        { "id": "EC-01", "text": "Người dùng hoàn tất luồng xác thực được hỗ trợ" }
      ],
      "acceptanceCriteria": [],
      "blockedByLocalIds": [],
      "suggestedPriority": "P2",
      "riskNotes": ["Cần DEV xác nhận threat model và authorization"]
    },
    {
      "localId": "story-login",
      "kind": "story",
      "parentLocalId": "epic-auth",
      "title": "Người dùng đăng nhập",
      "goal": "Người dùng có thể truy cập tài khoản đã xác thực",
      "scope": ["Đăng nhập bằng phương thức đã xác nhận"],
      "acceptanceCriteria": [
        { "id": "AC-01", "text": "Given ... When ... Then ..." }
      ],
      "blockedByLocalIds": [],
      "suggestedPriority": "P2",
      "riskNotes": ["Cần DEV xác nhận policy session và authorization"]
    },
    {
      "localId": "task-login-ui",
      "kind": "task",
      "parentLocalId": "story-login",
      "title": "Tích hợp giao diện đăng nhập",
      "goal": "Hiển thị luồng đăng nhập theo AC đã chốt",
      "scope": ["UI và test liên quan"],
      "acceptanceCriteria": [],
      "blockedByLocalIds": [],
      "suggestedPriority": "P2",
      "riskNotes": []
    }
  ]
}
```

`planHash` được tính bởi service trên canonical JSON theo RFC 8785, sau khi
service loại `planId` nếu ID được tạo ngẫu nhiên; request digest, schema version
và nội dung mọi node đều nằm trong hash. Confirmation phải chứa chính xác hash.
Các priority chỉ là đề xuất; Project không đổi Priority tới khi PO xác nhận
riêng hoặc tạo plan theo policy đã ghi rõ. Không tự gán assignee.

Validation deterministic bắt buộc:

- `rootKind` chỉ là `epic` hoặc `story`; có đúng một node root với kind tương
  ứng, parent graph không chu trình, mọi parent/dependency trỏ tới `localId` tồn tại.
- Epic chứa Story; Story có AC; Task thuộc một Story; không cho node tùy ý kiểu
  khác hoặc tự ý thêm tầng hierarchy ngoài policy.
- AC ID duy nhất trong phạm vi Story; Epic criterion dùng prefix `EC-`; title,
  body và số node qua giới hạn cấu hình; từ chối HTML/mention nguy hiểm.
- Plan chứa assumptions/open questions. Nếu có câu hỏi được policy đánh dấu
  blocking, không phát hành confirmation action cho đến khi refine giải quyết.
- Không nhận actor, role, repository ID, Issue ID, URL, assignee hay permission
  do Gemini sinh làm nguồn có thẩm quyền; service lấy từ event/policy/API.
- Plan chỉ tạo label/status backlog ban đầu. Không tạo approval, ready receipt,
  acceptance, `Closes #...` hoặc deploy action.

Giới hạn mặc định đề xuất: tối đa 1 root, 20 Story và 100 Task cho một plan;
input/output token, timeout và chi phí tối đa cấu hình theo deployment. Vượt giới
hạn thì trả câu hỏi/đề nghị chia plan, không cắt âm thầm. Một plan có thể đề xuất
chỉ một Story và các Task nếu yêu cầu nhỏ.

#### Confirmation và tạo Issue

`/ai-dlc create-plan plan=<id> hash=<sha256:...>` hợp lệ khi:

1. Actor numeric ID thuộc `roles.po`, Issue nằm trong installation/repository
   được phép và event là comment mới của human.
2. Plan còn TTL, confirmation hash khớp, Request Issue digest và schema version
   không stale; nếu Request Issue đổi phải refine tạo plan mới.
3. Mọi blocking question đã giải quyết; Issues chưa được tạo hoặc ledger cho
   thấy plan đang partial và được phép resume.
4. App policy còn hiệu lực, Project mapping hợp lệ và giới hạn số node/quota đạt.

Creation ledger khóa `planId + planHash`; tạo theo topological order (root,
Stories, Tasks). Mỗi Issue body có marker ổn định
`<!-- ai-dlc-plan:<planId>:<localId> -->`, source Request Issue và parent reference.
Ledger lưu operation state cùng mapping `localId -> repositoryId/issueNodeId/
issueNumber`. Nếu process dừng, resume đối soát marker/ledger trước mỗi create;
không xóa tự động các Issue đã tạo. GitHub bulk create không phải transaction
nguyên tử: trạng thái partial phải hiển thị rõ và PO có thể resume cùng plan/hash.

Nếu worker mất kết nối sau khi GitHub đã tạo Issue nhưng trước khi ledger ghi
nhận node ID, đánh dấu node `creation_unknown`; không gửi create lại ngay. Worker
đối soát Issue có marker trước qua API (không chỉ Search index); nếu không thể
xác minh chắc chắn thì giữ trạng thái blocked để maintainer xử lý. Không tuyên bố
exactly-once khi GitHub API không cung cấp transaction/idempotency key cho create.

Chỉ sau khi tất cả Issue cần thiết đã xác nhận tồn tại, App mới gắn label
`ai-dlc:plan-created`, comment link tổng hợp và thêm item vào Project. Nếu Project
update lỗi, các Issues vẫn giữ nguyên; ledger ghi lỗi Project để retry riêng.
Issue tạo xong ở Backlog/Refinement, không tự Ready. Snapshot/PO approval và DEV
readiness diễn ra theo workflow baseline mục 5–6 như công việc riêng.

#### Refinement và prompt safety

`/ai-dlc refine plan=<id>` chỉ chạy bởi PO trên Request Issue. Worker ghép request
ban đầu, câu trả lời human đã xác định và plan trước; comment/dữ liệu repo được
xem là input không tin cậy, không là system instruction. Gemini trả plan revision
mới; service tăng revision, hash mới, đánh dấu plan cũ superseded. Confirmation
cũ không còn hiệu lực.

Model call dùng system policy cố định phía server, JSON schema/structured output,
timeout, retry giới hạn và quota theo Issue/PO/installation. Không cấp tools,
shell, source checkout hoặc GitHub token cho model. Planner chỉ đọc Request Issue,
policy/template và tài liệu đã được PO role đọc; không đọc source code riêng tư
để tránh vượt quyền PO. Thiết kế kỹ thuật được DEV bổ sung sau khi Issues được tạo.

Nếu Gemini lỗi/quota hết, Request Issue giữ nguyên, App comment trạng thái lỗi
an toàn và cho phép retry với idempotency key khác theo attempt. Không tạo một
phần Issue trước khi plan được xác nhận. Nếu tạo cây lỗi giữa chừng, ledger giữ
partial state và resume cùng plan, không gọi Gemini lại hoặc tạo plan khác.
`issues.edited` trên Request Issue đánh dấu draft chờ confirmation stale; không
tự gọi Gemini lại hoặc tự bỏ draft. PO chủ động refine để có revision mới.
Project fields và labels không nằm trong request digest.

### 6.9 Planner service runtime

- GitHub gửi HTTPS webhook tới Cloud Run `planner-server`; xác minh
  `X-Hub-Signature-256` trên raw body bằng HMAC-SHA256/timing-safe compare trước
  khi parse JSON; giới hạn body size và reject delivery cũ/không đúng installation.
- Endpoint chỉ xác thực, ghi delivery dedupe trong Firestore và enqueue Cloud
  Tasks. Trả `202` sau khi queue bền vững; không giữ HTTP request mở trong lúc gọi model.
- Cloud Tasks gọi endpoint worker có IAM/OIDC riêng. Planner worker đọc policy
  từ branch mặc định qua App installation token ngắn hạn, kiểm tra lại Issue/actor,
  gọi Gemini server-side, validate plan và đăng comment.
- Firestore chỉ lưu delivery IDs, plan JSON/digest/TTL, operation ledger, localId
  mapping, retry attempt và trạng thái. GitHub Issues/Projects vẫn là nguồn chuẩn;
  Firestore không là backlog hoặc approval store.
- Cloud Run service account chỉ có quyền đọc đúng Secret Manager secrets, dùng
  Cloud Tasks và Firestore tương ứng. Tách service identity planner khỏi workflow
  Action; App private key có thể được mint từ broker/secret với quyền tối thiểu.
- HMAC, model API key, App private key, prompt và request text không xuất hiện
  trong log. Log metadata gồm delivery ID, plan ID, actor ID, model ID, token/cost
  và mã lỗi; không log request body đầy đủ.
- Kill switch `AI_DLC_PLANNER_ENABLED=false` ngăn enqueue/model call/create. Việc
  disable không làm mất Issue hoặc ledger; admin resume sau khi điều tra.

Cloud Run/Tasks/Firestore là reference deployment để dùng cùng Google Cloud và
Gemini API; đây là dependency vận hành thật, không phải feature GitHub native.
Nếu chọn provider khác, thay adapter/deployment bằng ADR tương đương; giữ nguyên
webhook validation, durable queue, role checks, idempotency và confirmation gates.

### 6.10 Local app (`huddle60 ui`)

Chế độ mặc định cho PO/DEV, thay planner service bằng một tiến trình Node chạy
trên máy người dùng.

```bash
gh auth login
export GEMINI_API_KEY=...   # chỉ cần để soạn kế hoạch; macOS: Keychain item "huddle60-gemini"
npx huddle60 ui --repo owner/name [--port 4317] [--no-open]
```

**Credential.** GitHub token lấy từ `GH_TOKEN`/`GITHUB_TOKEN`, nếu không có thì
`gh auth token`. Gemini key lấy từ `GEMINI_API_KEY`, hoặc trên macOS từ
`security find-generic-password -s huddle60-gemini -w`. Thiếu Gemini key thì phần
lập kế hoạch tắt (`E_CONFIG`), các phần khác vẫn chạy.

**Mô hình tin cậy.** App không có quyền nào hơn người dùng:

- Quyết định (`approve`, `ready`, `accept`) được đăng thành comment `/ai-dlc …`
  bằng token người dùng. Workflow Actions xử lý như comment gõ tay: kiểm tra role,
  hash, phụ thuộc, build rồi ghi receipt vào evidence branch. App kiểm tra role
  trước khi đăng chỉ để tránh comment thừa; nguồn quyết định vẫn là Actions.
- App chỉ **đọc** evidence branch để hiển thị trạng thái; không ghi evidence.
- Tạo Issues từ kế hoạch: app kiểm tra người dùng có role `po`, kế hoạch không còn
  câu hỏi chặn, rồi tạo Request Issue (label `ai-dlc:request`, body có
  `### Yêu cầu`) và cây Issues bằng cùng `IssueTreeCreator` của planner service
  (ledger, tạo parent-first, đối soát marker, sub-issue/Project best effort).
  Request Issue nhận comment tóm tắt kế hoạch, giả định và làm rõ của PO.

**API nội bộ** (JSON, header `X-AI-DLC-Token` bắt buộc):

| Method | Đường dẫn | Tác dụng |
|---|---|---|
| GET | `/api/session` | Repo, người dùng, role theo policy, trạng thái planner, lane |
| POST | `/api/plans` | Soạn kế hoạch từ `{title?, request}` |
| POST | `/api/plans/:id/refine` | Revision mới với `{clarification}` |
| POST | `/api/plans/:id/create` | Tạo Request Issue + cây Issues; gọi lại để tiếp tục khi bị gián đoạn |
| GET | `/api/items` | Epic/Story/Task đang mở kèm stage, người approve/ready, cờ đã sửa |
| POST | `/api/issues/:n/decisions` | `{action, lane?, runId?}` → đăng lệnh, trả `commentId` |
| GET | `/api/issues/:n/replies/:commentId` | Tìm reply của bot theo marker `ai-dlc:reply:<commentId>` |
| GET | `/api/builds` | Run `push` thành công gần nhất của `acceptance.build_workflows` trên branch mặc định |
| GET | `/api/issues/:n/context` | Agent context (mục 12.1) |

**Stage hiển thị** chỉ tính trên receipt hợp lệ có `baselineHash` bằng hash nội dung
hiện tại: có `ready` → _đang làm_; Task hoặc có `approve` → _chờ DEV ready_; còn lại
→ _chờ PO duyệt_. Có receipt cũ nhưng không có receipt cho nội dung hiện tại → cờ
_đã sửa sau quyết định_.

**Bảo vệ HTTP.**

- Chỉ listen `127.0.0.1`. Token phiên 32 byte ngẫu nhiên mỗi lần khởi động, đưa vào
  URL fragment (`#token=`) để không đi vào log/Referer; UI chuyển sang
  `sessionStorage` và xóa khỏi URL. So sánh token timing-safe.
- `Host` phải là `127.0.0.1:<port>` hoặc `localhost:<port>` (chống DNS rebinding);
  `Origin` nếu có phải cùng origin (chống CSRF); POST bắt buộc `application/json`,
  body tối đa 256 KB, validate bằng zod.
- File tĩnh theo allowlist cố định; CSP `default-src 'none'; script-src 'self'; …;
  frame-ancestors 'none'`, `nosniff`, `no-referrer`, `no-store`. UI chỉ dùng
  `textContent`/DOM API, không dựng HTML từ dữ liệu Issue hoặc model.
- Lỗi không mong đợi trả thông báo chung; chi tiết chỉ ghi ở terminal.

**Giới hạn.** Bản nháp kế hoạch và ledger nằm trong bộ nhớ tiến trình: tắt app
trước khi tạo xong thì phải soạn lại (Issues đã tạo vẫn còn, có marker
`ai-dlc:plan-node`). Chỉ hỗ trợ github.com. Không chạy song song local app và
planner service trên cùng repository để tránh hai bên cùng lập kế hoạch.

## 7. Evidence store

### 7.1 Ghi dữ liệu

Ghi qua Git Data API bằng App token, không clone repository:

1. Đọc ref `heads/ai-dlc-evidence`, lấy commit và tree hiện tại.
2. Nếu đường dẫn đích đã tồn tại: nội dung giống thì trả về thành công; khác thì `E_CONFLICT`.
3. Tạo blob, tree mới với base tree, commit với message
   `ai-dlc: <kind> <id> (issue #<n>)`.
4. Cập nhật ref với `force: false`.
5. Nếu bị từ chối do ref đã thay đổi, quay lại bước 1. Tối đa 5 lần, backoff
   0,5 / 1 / 2 / 4 / 8 giây, sau đó báo `E_GITHUB_API`.

Mỗi file có đường dẫn riêng theo ID nên không có xung đột nội dung khi retry.

### 7.2 Đọc dữ liệu

Đọc qua Contents API với `ref=ai-dlc-evidence`. Liệt kê decision của một Issue
bằng cách đọc thư mục `decisions/<repoId>/<issueNumber>/`. Khi số file lớn,
chuyển sang Git Trees API; không cần index riêng.

### 7.3 Khởi tạo

Branch `ai-dlc-evidence` được tạo một lần dưới dạng orphan với file `README.md`
mô tả cấu trúc. Không merge branch này vào branch mặc định.

## 8. PR checks

### 8.1 Khối AI-DLC trong PR body

```text
<!-- ai-dlc:begin -->
AI-DLC-Issue: #11
AI-DLC-Baseline: bl-11-3f2a9c1d7e4b
AI-DLC-Hash: sha256:3f2a9c1d7e4b0000000000000000000000000000000000000000000000000000
AI-DLC-AC: AC-01, AC-02
<!-- ai-dlc:end -->
```

Agent context CLI sinh khối này. Thiếu khối thì PR chỉ hợp lệ nếu có label
`ai-dlc:exempt` do maintainer gắn, dùng cho thay đổi không thuộc Story (ví dụ
sửa tài liệu dự án). Label này được ghi lại trong status description.

### 8.2 `ai-dlc/baseline`

Chạy khi PR `opened`, `edited`, `synchronize`, `reopened`, `ready_for_review`.
Ghi commit status trên PR head SHA với context `ai-dlc/baseline`.

Kiểm tra theo thứ tự, dừng ở lỗi đầu tiên:

1. Parse khối AI-DLC; Issue cùng repository; là Story hoặc Task.
2. Snapshot tồn tại, hash tính lại khớp `AI-DLC-Hash`.
3. Hash của nội dung Issue hiện tại bằng hash snapshot (`E_STALE` nếu khác).
4. Có `ready` hợp lệ cho baseline; nếu lane yêu cầu thì có `approve` hợp lệ.
5. Mọi AC trong `AI-DLC-AC` tồn tại trong snapshot.
6. Danh sách file PR không chạm `sensitive_paths` khi lane là `fast`.
7. PR body không chứa closing keyword (`close`, `fix`, `resolve` và biến thể)
   trỏ tới Story/Epic (`E_CLOSING_KEYWORD`).

Thành công: status `success`, description `bl-11-3f2a… ready (standard)`.
Thất bại: status `failure`, description là mã lỗi; chi tiết ghi vào job summary.

Task thuộc Story: Task dùng baseline của chính nó. Story cha phải có `ready` hợp
lệ; kiểm tra này nằm ở bước 4 qua trường `parent` của snapshot Task.

### 8.3 `ai-dlc/trace`

Chạy cùng workflow, không bắt buộc ở giai đoạn đầu. So sánh AC khai báo trong
PR với AC của snapshot và báo phần chưa được PR nào khai báo trong Story. Kết
quả là thông tin hỗ trợ review, không thay quyết định của reviewer.

### 8.4 Workflow

`.github/workflows/ai-dlc-pr-checks.yml`:

```yaml
name: ai-dlc-pr-checks
on:
  pull_request_target:
    types: [opened, edited, synchronize, reopened, ready_for_review]
permissions: {}
jobs:
  check:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.repository.default_branch }}
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ vars.AI_DLC_APP_ID }}
          private-key: ${{ secrets.AI_DLC_APP_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
      - run: node dist/main.js pr-check
        env:
          AI_DLC_TOKEN: ${{ steps.app-token.outputs.token }}
```

Dùng `pull_request_target` để ghi status cho PR từ fork. Điều này chỉ an toàn vì
workflow **chỉ checkout branch mặc định** và đọc PR qua API. Tuyệt đối không
checkout `github.event.pull_request.head.sha`, không chạy script/dependency
của PR trong job này.

**Cần kiểm chứng:** nếu bật merge queue, required check phải chạy cả trên event
`merge_group`. Phương án này chưa hỗ trợ merge queue; không bật merge queue cho
đến khi có handler và test riêng.

## 9. Stale detector

`.github/workflows/ai-dlc-issue-edited.yml` chạy trên `issues: [edited]`, bỏ qua bot.

1. Tính hash nội dung Issue hiện tại.
2. Tìm baseline mới nhất có receipt `approve` hoặc `ready` hợp lệ.
3. Nếu hash khác: gắn `ai-dlc:stale`, comment một lần (marker theo baseline ID),
   chuyển Project Status từ Ready/In Progress về Refinement.
4. Tìm PR mở có khối AI-DLC trỏ Issue này qua Search API
   (`repo:<owner>/<repo> is:pr is:open "AI-DLC-Issue: #11"`), ghi lại status
   `ai-dlc/baseline` là `failure` với `E_STALE` trên head SHA của từng PR.
5. Nếu hash trở về bằng baseline đã duyệt, gỡ label và chạy lại check cho PR.

Search API có độ trễ index; reconciler (mục 11) chạy lại bước 4 định kỳ. Kiểm
tra ở mục 8.2 bước 3 vẫn là gate chính khi PR có commit hoặc chỉnh sửa mới.

## 10. Evidence report theo AC

### 10.1 Quy ước test

Tên test chứa tag AC trong ngoặc vuông, ví dụ `[AC-01] từ chối ngày kết thúc
trước ngày bắt đầu`. Một test có thể gắn nhiều AC. CI xuất JUnit XML.

### 10.2 Workflow build

`.github/workflows/build.yml` chạy trên `push` vào branch mặc định, build, chạy
test, upload JUnit với tên artifact `junit` và deploy preview nếu có. Một job
cuối chạy `node dist/main.js ac-report` với `GITHUB_TOKEN` quyền `contents: read`,
đọc JUnit trong workspace hiện tại và ghi bảng vào job summary:

| AC | Test | Kết quả |
|---|---|---|
| AC-01 | `[AC-01] từ chối ngày kết thúc trước ngày bắt đầu` | passed |
| AC-02 | — | chưa có test tự động |

Report không ghi vào evidence store. Khi PO chạy `accept`, handler đọc lại run
qua API (mục 6.6); bảng report là thông tin hỗ trợ PO quyết định. AC không kiểm
thử tự động được ghi "chưa có test tự động", không được hiển thị là passed.

`ci.yml` chạy trên `pull_request` với `contents: read`, không có secret. Đây là
CI kỹ thuật cho PR, tách hoàn toàn khỏi workflow `pull_request_target`.

## 11. Reconciler

`.github/workflows/ai-dlc-reconcile.yml` chạy theo `schedule` mỗi giờ và
`workflow_dispatch`. Mỗi lần chạy:

1. Story/Epic đã đóng trong 7 ngày gần nhất mà không có `accept` hợp lệ: gắn
   `ai-dlc:needs-acceptance` và comment; mở lại nếu
   `reconcile.reopen_unaccepted_close` là `true`.
2. Story/Epic có Project Status Done nhưng thiếu `accept` hợp lệ: chuyển về
   Acceptance và comment.
3. PR mở có khối AI-DLC: chạy lại kiểm tra mục 8.2 và ghi status nếu kết quả khác.
4. Epic: liệt kê Story trong trường `Story bắt buộc` chưa có `accept` hợp lệ;
   ghi vào comment tổng hợp của Epic (sửa một comment có marker). Epic chỉ Done
   khi PO chạy `accept` cho chính Epic.

Reconciler không tự tạo receipt. Nó chỉ hạ trạng thái hoặc báo thiếu, không bao
giờ nâng trạng thái.

## 12. Agent

### 12.1 Context CLI

```text
npx huddle60 context --issue 11
```

CLI dùng token của người chạy (`GH_TOKEN`/`GITHUB_TOKEN`, nếu không có thì
`gh auth token`) và in ra Markdown gồm (nút **context** trong local app trả cùng nội dung):

- Baseline ID, hash, lane và trạng thái hiệu lực của approve/ready.
- Nội dung yêu cầu **từ snapshot**, không từ Issue hiện tại.
- Danh sách AC và tham chiếu kỹ thuật.
- Cảnh báo nếu Issue đã bị sửa sau baseline.
- Khối AI-DLC sẵn để dán vào PR body.

CLI từ chối xuất ngữ cảnh thực thi nếu chưa có `ready` hợp lệ, trừ khi chạy với
`--draft` để làm rõ yêu cầu; khi đó đầu ra ghi rõ là bản nháp, không dùng để code.

### 12.2 `AGENTS.md`

```markdown
# Hướng dẫn cho AI agent

1. Trước khi code, chạy `npx huddle60 context --issue <số>` (hoặc
   dùng nội dung từ nút context trong `huddle60 ui`) và chỉ làm theo baseline trong
   đầu ra. Nếu lệnh báo chưa ready hoặc stale, dừng lại.
2. Chỉ sửa file trong phạm vi Task. Không sửa `.github/`, `src/` của automation,
   `schemas/` hoặc `AGENTS.md` trừ khi Task yêu cầu rõ.
3. Mỗi test gắn tag AC trong tên, ví dụ `[AC-01] ...`.
4. PR body phải chứa khối AI-DLC do context CLI sinh ra và mẫu báo cáo trong
   PULL_REQUEST_TEMPLATE. Dùng `Refs #<số>`, không dùng `Closes`, `Fixes`, `Resolves`.
5. Ghi rõ phần chưa kiểm tra và giả định. Không viết rằng CI đã pass nếu chưa
   có kết quả CI.
6. Không chạy lệnh `/ai-dlc approve`, `ready` hoặc `accept` và không bấm nút tương
   ứng trong `huddle60 ui`; đó là quyết định của con người.
```

Nếu dùng công cụ đọc file hướng dẫn riêng (ví dụ `.github/copilot-instructions.md`),
file đó chỉ dẫn tới `AGENTS.md` để tránh hai bộ quy tắc khác nhau.

### 12.3 PR template

`.github/PULL_REQUEST_TEMPLATE.md`:

```markdown
Refs #

<!-- ai-dlc:begin -->
<!-- Dán khối từ npm run ai-dlc:context -->
<!-- ai-dlc:end -->

## Đã thay đổi / AC liên quan

## Đã kiểm tra (lệnh, kết quả)

## Chưa kiểm tra / giới hạn / giả định

## Cần ai quyết định gì
```

## 13. Thông số kỹ thuật chung

| Hạng mục | Lựa chọn |
|---|---|
| Runtime | Node.js 22, TypeScript strict, ESM; Actions và Cloud Run dùng cùng major |
| Thư viện | `@actions/core`, `@octokit/rest`, `@octokit/graphql`, `@octokit/auth-app`, `@octokit/plugin-retry`, `@octokit/plugin-throttling`, `@google/genai`, `@google-cloud/firestore`, `@google-cloud/tasks`, `ajv`, `canonicalize`, `yaml`, `fast-xml-parser` |
| Build | `esbuild` đóng gói `src/main.ts`, `src/cli/context.ts`, `src/planner-server.ts` và planner worker thành entry points riêng |
| Test | `vitest`; coverage tối thiểu 90% cho `src/core/` |
| Lint | `eslint` và `prettier`; `tsc --noEmit` trong CI |
| Logging | `@actions/core` cho Actions; structured Cloud Logging cho planner; redact secrets và không log body Issue/comment/prompt đầy đủ |

Lệnh npm cần có: `build`, `test`, `lint`, `typecheck`, `ai-dlc:context`,
`planner:start` và `planner:worker`. Unit/default integration tests mock Gemini
và GitHub; chỉ lệnh planner integration rõ ràng mới gọi service test. Không có
lệnh local mặc định ghi repository production hoặc phát sinh Gemini usage.

Retry API: tối đa 3 lần cho lỗi 5xx và secondary rate limit, tôn trọng
`retry-after`. Hết retry thì báo `E_GITHUB_API` và không nâng trạng thái.
Gemini: retry 429/5xx tối đa 2 lần theo retry-after/exponential backoff; không
retry schema/permission errors. Cloud Tasks có max attempts/max backoff hữu hạn.
Plan creation luôn resume từ ledger; không gọi lại Gemini khi retry operation.
Firestore plan payload có TTL 30 ngày sau trạng thái terminal; Issue/comment
vẫn là nơi PO xem lịch sử, log chỉ lưu metadata. Giá trị quota/cost max phải
được cấu hình theo deployment trước khi bật webhook.

## 14. Kế hoạch triển khai

Mỗi giai đoạn kết thúc bằng PR được review và test đạt. Không bắt đầu giai đoạn
sau khi giai đoạn trước chưa có test chứng minh tiêu chí tương ứng.

| Giai đoạn | Đầu ra | Tiêu chí hoàn thành | WF |
|---|---|---|---|
| 0. Nền tảng | Repo skeleton, `package.json`, lint/test/build CI, schemas, policy loader | `npm test` chạy được; policy sai bị từ chối | — |
| 1. Cấu hình GitHub | Issue forms, labels, Project fields, rulesets, CODEOWNERS, GitHub App | Tạo được Epic/Story/Task qua form và đưa vào Project; Project workflow auto-Done đã tắt | WF-01 |
| 2. Core | `canonical`, `issue-form`, `command`, `baseline`, `decision`, `pr-block` | Unit test cho chuẩn hóa, hash ổn định, parse form/lệnh/khối PR, các ca lỗi | — |
| 3. Evidence store | Ghi/đọc idempotent, retry khi ref đổi | Integration test hai lần ghi đồng thời không mất file; ghi lại cùng nội dung thành công | WF-09 |
| 4. Gemini planner | Request Issue, App webhook, Cloud Tasks/Run/Firestore, Gemini schema/eval | PO nhập một câu; draft trả đúng Issue; không tạo child trước confirmation; non-PO bị từ chối | WF-13 đến WF-17 |
| 5. Confirmation và Issue creation | Plan hash, PO command, creation ledger, Project/parent/dependency links | Hash/body stale bị chặn; tạo parent-first; duplicate delivery không nhân bản; partial failure resume được | WF-18 đến WF-21 |
| 6. Baseline và approve | Lệnh `baseline`, `approve`, `revoke`; phản hồi comment | PO tạo baseline và approve; non-PO bị từ chối; sửa/xóa comment làm receipt mất hiệu lực | WF-02, WF-03 |
| 7. Ready và PR check | Lệnh `ready`, check `ai-dlc/baseline`, stale detector | PR thiếu ready hoặc Issue bị sửa bị chặn; fork PR không lấy được secret | WF-03, WF-04, WF-10 |
| 8. Agent | Context CLI, `AGENTS.md`, PR template | DEV tạo PR có khối hợp lệ chỉ từ baseline CLI trong IDE | WF-04 |
| 9. Nghiệm thu | `build.yml`, AC report, lệnh `accept`, cập nhật Project | Merge không làm Story Done; accept với run sai commit/branch bị từ chối | WF-05, WF-06, WF-07 |
| 10. Reconcile và vận hành | Reconciler, runbook, kill switch | Issue/run lỗi được phát hiện; tắt planner không làm mất request/ledger | WF-08, WF-11, WF-12 |
| 11. Local app | `huddle60 ui`, `huddle60 init`, approve/ready một bước | PO soạn và tạo cây Issues không cần Cloud; nút quyết định chỉ đăng lệnh, Actions xác nhận; token/Host/Origin được kiểm tra | WF-13 đến WF-21 (chế độ local) |

Các nhóm có thể làm song song: giai đoạn 1 và phần core của 2; 3 cần 0/2;
4 cần App, Issue form, policy và schema; 5 cần 4 cùng Project/GitHub integration.

## 15. Kiểm thử

### 15.1 Unit

- Canonical hóa: cùng nội dung khác CRLF/khoảng trắng cuối dòng cho cùng hash;
  khác một ký tự nghiệp vụ cho hash khác; bỏ trường `contentHash` trước khi băm.
- Issue form: thiếu heading bắt buộc, AC trùng ID, AC sai định dạng.
- Command: lệnh không ở dòng đầu, trong code block, tham số thiếu/lạ/lặp, value có nháy.
- Planner: schema sai, ID trùng, parent cycle, quá giới hạn, câu hỏi blocking,
  prompt injection trong Issue/comment và provider timeout/quota.
- Confirmation/create: sai PO role/hash/source digest, stale plan, duplicate
  delivery, retry sau mỗi bước create, parent/dependency link và Project API lỗi.
- Decision: từng điều kiện ở mục 5.4 sai riêng lẻ đều làm receipt mất hiệu lực.
- PR block: thiếu marker, nhiều khối, Issue khác repository, closing keyword.

### 15.2 Fixtures

Lưu payload event thật đã khử dữ liệu vào `tests/fixtures/` cho `issue_comment`
(created, edited, deleted), `issues.edited`, `pull_request_target` từ cùng repo
và từ fork, response `actions/runs/{id}`. Fixture không chứa token, email hoặc
nội dung private.

### 15.3 Integration và E2E

Dùng một repository và Project kiểm thử riêng, App cài riêng. GitHub integration
tests chỉ chạy khi đặt `AI_DLC_INTEGRATION=1`; planner test mặc định mock Gemini,
Firestore và Cloud Tasks. Test gọi Gemini thật chỉ chạy riêng khi đặt
`AI_DLC_PLANNER_INTEGRATION=1`, dùng project/quota thử nghiệm, dữ liệu tổng hợp
và ngân sách tối đa được maintainer xác nhận. Kịch bản E2E bắt buộc:

1. Tạo Epic và Story qua form → `baseline` → `approve` → `ready`.
2. Mở PR có khối AI-DLC → check pass → sửa Issue → check chuyển `E_STALE`.
3. Tạo baseline mới, approve/ready lại → cập nhật PR → check pass → merge.
4. Story không chuyển Done sau merge → `accept` với run của `build.yml` → Done.
5. Xóa comment accept → reconciler đưa Story về Acceptance.
6. PR từ fork sửa workflow để in secret → không có secret nào bị lộ, check vẫn chạy từ branch mặc định.
7. PO tạo Request Issue với một câu → planner comment cây Epic/Story/Task có hash;
   trước lệnh confirm chưa có child Issue nào.
8. Non-PO tạo Request Issue hoặc gọi `/ai-dlc create-plan` → không Gemini call,
   không Issue creation; duplicate webhook chỉ tạo một plan job.
9. PO sửa request sau draft → plan cũ bị stale; refine tạo revision/hash mới;
   confirm hash cũ bị từ chối.
10. Gemini trả JSON lỗi, timeout, 429 hoặc vượt quota → không tạo Issue; retry có
  giới hạn và Request Issue vẫn cho phép thử lại.
11. Confirm hợp lệ → Issues tạo theo parent-first, các node liên kết đúng, nằm
  trong Project và đều trỏ về Request Issue.
12. App dừng giữa quá trình tạo → ledger hiển thị partial; resume tiếp tục cùng
  plan/hash, không tạo trùng hoặc xóa Issues đã tạo.
13. Project API lỗi sau khi tạo Issues → không tạo lại Issues khi retry Project update.
14. App comment kích hoạt webhook lần nữa → không loop model call hoặc tạo cây mới.
15. Local app: PO soạn kế hoạch, refine, tạo Issues; DEV/người không có role không
  tạo được. Bấm approve/ready/accept → comment xuất hiện dưới tên người dùng,
  Actions trả lời và stage trong app cập nhật.
16. Local app: request thiếu token, sai `Host` hoặc `Origin` lạ bị từ chối; trang
  khác trong trình duyệt không gọi được API.

## 16. Vận hành

- **Kill switch:** biến repository `AI_DLC_ENABLED=false` làm mọi handler thoát
  sớm và ghi status `pending` với mô tả "AI-DLC disabled" cho PR. Required check
  vì vậy chặn merge thay vì cho qua; maintainer có thể tạm gỡ check khỏi ruleset
  nếu cần merge khẩn cấp và phải ghi lý do trong Issue.
- **Planner kill switch:** `AI_DLC_PLANNER_ENABLED=false` chặn enqueue, Gemini và
  Issue creation; deterministic baseline/PR checks vẫn hoạt động. Chỉ maintainer
  bật lại sau khi kiểm tra quota, webhook secret và ledger.
- **Cloud Tasks:** cấu hình retry/backoff/max attempts; dead-letter/failed task
  hiển thị plan ID và delivery ID, không tự sinh plan mới.
- **Firestore:** bật TTL cho plan payload sau 30 ngày terminal; backup/export
  theo policy, không lưu token/prompt thô và không dùng store làm backlog.
- **Thu hồi App:** gỡ cài đặt App hoặc xóa private key làm mọi ghi dừng ngay.
- **Khôi phục:** evidence là lịch sử Git; sao lưu bằng mirror định kỳ sang
  repository khác chỉ App/admin đọc được.
- **Giám sát:** Actions summary cho workflow; Cloud Logging/Monitoring cho planner
  với delivery/plan ID, latency, Gemini usage/cost, retry, partial create và
  quota. Không log body yêu cầu hoặc prompt đầy đủ.
- **Nâng cấp schema:** handler đọc được mọi `schemaVersion` đã phát hành; chỉ ghi
  phiên bản mới nhất. Không chuyển đổi file cũ trong evidence store.

## 17. Giới hạn đã biết

- Issue edit và merge không nằm trong một giao dịch. Giữa lúc Issue bị sửa và lúc
  stale detector chạy, PR vẫn có thể được merge với status cũ. Gate được kiểm
  tra lại khi PR thay đổi và reconciler báo sau đó; không chặn tuyệt đối mọi race.
- Admin repository có thể thay ruleset hoặc lịch sử Git. Evidence store chống
  sửa vô tình và ghi lại thay đổi, không phải lưu trữ bất biến tuyệt đối.
- Dependency đọc từ trường `Blocked by` trong Issue form. Sub-issues và issue
  dependencies native có thể thay thế sau khi kiểm chứng API và quyền.
- Một repository duy nhất. Issue và code ở hai repository cần ADR riêng về quyền
  đọc chéo và định dạng tham chiếu.
- Nghiệm thu chỉ trên build sau merge. Nghiệm thu trên preview của PR chưa hỗ trợ.
- Local app giữ bản nháp kế hoạch trong bộ nhớ, chỉ hỗ trợ github.com và cần mỗi
  PO có Gemini key (cá nhân hoặc do tổ chức cấp). Stage trong app phụ thuộc
  Actions đã xử lý xong; khi Actions chậm hoặc lỗi, app báo chưa có phản hồi.
