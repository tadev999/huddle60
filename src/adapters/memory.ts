import { canonicalJson } from "../core/canonical.js";
import { AiDlcError } from "../core/errors.js";
import type { PlanRecord } from "../core/plan.js";
import type { CreationLedger, EvidenceStore, Logger, PlanStore } from "../ports.js";

export class MemoryEvidenceStore implements EvidenceStore {
  readonly files = new Map<string, string>();

  async read<T>(path: string): Promise<T | null> {
    const value = this.files.get(path);
    return value === undefined ? null : (JSON.parse(value) as T);
  }

  async write(path: string, value: unknown): Promise<"created" | "unchanged"> {
    const serialized = canonicalJson(value);
    const existing = this.files.get(path);
    if (existing === undefined) {
      this.files.set(path, serialized);
      return "created";
    }
    if (existing === serialized) return "unchanged";
    throw new AiDlcError(
      "E_CONFLICT",
      `Evidence already exists with different content at ${path}.`,
    );
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((path) => path.startsWith(prefix)).sort();
  }
}

export class MemoryPlanStore implements PlanStore {
  readonly deliveries = new Set<string>();
  readonly plans = new Map<string, PlanRecord>();
  readonly ledgers = new Map<string, CreationLedger>();
  private readonly leases = new Map<string, { owner: string; until: number }>();

  async claimDelivery(deliveryId: string): Promise<boolean> {
    if (this.deliveries.has(deliveryId)) return false;
    this.deliveries.add(deliveryId);
    return true;
  }

  async releaseDelivery(deliveryId: string): Promise<void> {
    this.deliveries.delete(deliveryId);
  }

  async getPlan(planId: string): Promise<PlanRecord | null> {
    return structuredClone(this.plans.get(planId) ?? null);
  }

  async latestPlanForIssue(repositoryId: number, issueNumber: number): Promise<PlanRecord | null> {
    const candidates = [...this.plans.values()].filter(
      (plan) =>
        plan.source.repositoryId === repositoryId && plan.source.issueNumber === issueNumber,
    );
    candidates.sort((a, b) => b.revision - a.revision);
    return structuredClone(candidates[0] ?? null);
  }

  async savePlan(record: PlanRecord): Promise<void> {
    this.plans.set(record.planId, structuredClone(record));
  }

  async getLedger(planId: string): Promise<CreationLedger | null> {
    return structuredClone(this.ledgers.get(planId) ?? null);
  }

  async saveLedger(ledger: CreationLedger): Promise<void> {
    this.ledgers.set(ledger.planId, structuredClone(ledger));
  }

  async acquireLease(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const current = this.leases.get(key);
    const now = Date.now();
    if (current && current.until > now && current.owner !== owner) return false;
    this.leases.set(key, { owner, until: now + ttlMs });
    return true;
  }

  async releaseLease(key: string, owner: string): Promise<void> {
    if (this.leases.get(key)?.owner === owner) this.leases.delete(key);
  }
}

/** JSON lines on stdout/stderr, which Cloud Logging parses as structured entries. */
export function createJsonLogger(base: Record<string, unknown> = {}): Logger {
  const write = (severity: string, message: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({ severity, message, ...base, ...fields });
    if (severity === "ERROR") process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return {
    info: (message, fields) => write("INFO", message, fields),
    warn: (message, fields) => write("WARNING", message, fields),
    error: (message, fields) => write("ERROR", message, fields),
  };
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
