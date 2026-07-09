import type { CreditLedgerRepository } from "../../domain/ports";

export class D1CreditLedgerRepository implements CreditLedgerRepository {
  constructor(private db: D1Database) {}

  async chargeOne(apiKeyId: string, jobId: string): Promise<boolean> {
    // The conditional UPDATE is the sole atomicity guarantee: SQLite serializes
    // it, so two concurrent charges against a balance of 1 can never both succeed.
    const result = await this.db
      .prepare("UPDATE api_keys SET credit_balance = credit_balance - 1 WHERE id = ? AND credit_balance > 0")
      .bind(apiKeyId)
      .run();
    if (result.meta.changes === 0) return false;

    await this.db
      .prepare("INSERT INTO credit_ledger (id, key_id, job_id, delta, reason, created_at) VALUES (?, ?, ?, -1, 'charge', ?)")
      .bind(crypto.randomUUID(), apiKeyId, jobId, new Date().toISOString())
      .run();
    return true;
  }

  async refundOne(apiKeyId: string, jobId: string): Promise<void> {
    try {
      await this.db.batch([
        this.db
          .prepare("INSERT INTO credit_ledger (id, key_id, job_id, delta, reason, created_at) VALUES (?, ?, ?, 1, 'refund', ?)")
          .bind(crypto.randomUUID(), apiKeyId, jobId, new Date().toISOString()),
        this.db.prepare("UPDATE api_keys SET credit_balance = credit_balance + 1 WHERE id = ?").bind(apiKeyId),
      ]);
    } catch (err) {
      // UNIQUE(job_id, reason) violation means this job was already refunded;
      // the whole batch rolled back, so the balance was never double-incremented.
      if (String(err).includes("UNIQUE constraint")) return;
      throw err;
    }
  }

  async grant(apiKeyId: string, amount: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare("INSERT INTO credit_ledger (id, key_id, job_id, delta, reason, created_at) VALUES (?, ?, NULL, ?, 'grant', ?)")
        .bind(crypto.randomUUID(), apiKeyId, amount, new Date().toISOString()),
      this.db
        .prepare("UPDATE api_keys SET credit_balance = credit_balance + ? WHERE id = ?")
        .bind(amount, apiKeyId),
    ]);
  }
}
