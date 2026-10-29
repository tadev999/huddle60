import { Firestore, Timestamp } from "@google-cloud/firestore";
import type { PlanRecord } from "../core/plan.js";
import type { CreationLedger, PlanStore } from "../ports.js";

const DELIVERY_TTL_MS = 7 * 86_400_000;
const ALREADY_EXISTS = 6;

/**
 * Firestore holds only coordination data: delivery dedupe, plan drafts, creation
 * ledgers and leases. Configure a TTL policy on the `expireAt` field.
 */
export class FirestorePlanStore implements PlanStore {
  constructor(
    private readonly db: Firestore,
    private readonly prefix = "ai-dlc",
  ) {}

  private collection(name: string) {
    return this.db.collection(`${this.prefix}-${name}`);
  }

  async claimDelivery(deliveryId: string): Promise<boolean> {
    try {
      await this.collection("deliveries")
        .doc(deliveryId)
        .create({
          claimedAt: Timestamp.now(),
          expireAt: Timestamp.fromMillis(Date.now() + DELIVERY_TTL_MS),
        });
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === ALREADY_EXISTS) return false;
      throw error;
    }
  }

  async releaseDelivery(deliveryId: string): Promise<void> {
    await this.collection("deliveries").doc(deliveryId).delete();
  }

  async getPlan(planId: string): Promise<PlanRecord | null> {
    const snapshot = await this.collection("plans").doc(planId).get();
    return snapshot.exists ? ((snapshot.data() as { record: PlanRecord }).record ?? null) : null;
  }

  async latestPlanForIssue(repositoryId: number, issueNumber: number): Promise<PlanRecord | null> {
    // Single equality filter: no composite index needed. Revisions per Issue are capped.
    const snapshot = await this.collection("plans")
      .where("sourceKey", "==", `${repositoryId}#${issueNumber}`)
      .get();
    const records = snapshot.docs.map((doc) => (doc.data() as { record: PlanRecord }).record);
    records.sort((a, b) => b.revision - a.revision);
    return records[0] ?? null;
  }

  async savePlan(record: PlanRecord): Promise<void> {
    await this.collection("plans")
      .doc(record.planId)
      .set({
        record,
        sourceKey: `${record.source.repositoryId}#${record.source.issueNumber}`,
        expireAt: Timestamp.fromDate(new Date(record.expiresAt)),
      });
  }

  async getLedger(planId: string): Promise<CreationLedger | null> {
    const snapshot = await this.collection("ledgers").doc(planId).get();
    return snapshot.exists ? (snapshot.data() as CreationLedger) : null;
  }

  async saveLedger(ledger: CreationLedger): Promise<void> {
    await this.collection("ledgers").doc(ledger.planId).set(ledger);
  }

  async acquireLease(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const ref = this.collection("leases").doc(encodeURIComponent(key));
    return this.db.runTransaction(async (transaction) => {
      const current = await transaction.get(ref);
      const data = current.data() as { owner: string; until: number } | undefined;
      if (data && data.until > Date.now() && data.owner !== owner) return false;
      transaction.set(ref, {
        owner,
        until: Date.now() + ttlMs,
        expireAt: Timestamp.fromMillis(Date.now() + ttlMs),
      });
      return true;
    });
  }

  async releaseLease(key: string, owner: string): Promise<void> {
    const ref = this.collection("leases").doc(encodeURIComponent(key));
    await this.db.runTransaction(async (transaction) => {
      const current = await transaction.get(ref);
      if ((current.data() as { owner?: string } | undefined)?.owner === owner)
        transaction.delete(ref);
    });
  }
}
