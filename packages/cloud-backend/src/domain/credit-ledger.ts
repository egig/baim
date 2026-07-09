export type CreditLedgerReason = "charge" | "refund" | "grant";

export interface CreditLedgerEntry {
  id: string;
  keyId: string;
  jobId: string | null;
  delta: number;
  reason: CreditLedgerReason;
  createdAt: string;
}
