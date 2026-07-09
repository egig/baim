import type { ApiKeyRepository, CreditLedgerRepository } from "../domain/ports";

export class CreditService {
  constructor(
    private ledger: CreditLedgerRepository,
    private apiKeys: ApiKeyRepository
  ) {}

  async charge(apiKeyId: string, jobId: string): Promise<boolean> {
    return this.ledger.chargeOne(apiKeyId, jobId);
  }

  async refund(apiKeyId: string, jobId: string): Promise<void> {
    return this.ledger.refundOne(apiKeyId, jobId);
  }

  async getBalance(apiKeyId: string): Promise<number | null> {
    const key = await this.apiKeys.findById(apiKeyId);
    return key ? key.creditBalance : null;
  }
}
