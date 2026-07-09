import type { UserRepository, ApiKeyRepository } from "../domain/ports";
import { hashKey } from "./hash-key";

export class AuthService {
  constructor(
    private users: UserRepository,
    private apiKeys: ApiKeyRepository
  ) {}

  async register(): Promise<{ apiKey: string; userId: string }> {
    const userId = crypto.randomUUID();
    const rawKey = crypto.randomUUID();
    const keyHash = await hashKey(rawKey);

    await this.users.create({ id: userId, createdAt: new Date().toISOString() });
    await this.apiKeys.create({
      id: crypto.randomUUID(),
      userId,
      keyHash,
      creditBalance: 0,
      createdAt: new Date().toISOString(),
    });

    return { apiKey: rawKey, userId };
  }

  async authenticate(authorization: string | undefined): Promise<{ userId: string; apiKeyId: string } | null> {
    if (!authorization) return null;
    const parts = authorization.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") return null;
    const keyHash = await hashKey(parts[1]);
    const key = await this.apiKeys.findByKeyHash(keyHash);
    if (!key) return null;
    return { userId: key.userId, apiKeyId: key.id };
  }
}
