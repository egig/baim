import type { User, ApiKey } from "../../domain/user";
import type { UserRepository, ApiKeyRepository } from "../../domain/ports";

export class D1UserRepository implements UserRepository {
  constructor(private db: D1Database) {}

  async create(user: User): Promise<void> {
    await this.db
      .prepare("INSERT INTO users (id, created_at) VALUES (?, ?)")
      .bind(user.id, user.createdAt)
      .run();
  }

  async findById(id: string): Promise<User | null> {
    const row = await this.db
      .prepare("SELECT id, created_at FROM users WHERE id = ?")
      .bind(id)
      .first();
    if (!row) return null;
    const r = row as Record<string, unknown>;
    return { id: r.id as string, createdAt: r.created_at as string };
  }
}

export class D1ApiKeyRepository implements ApiKeyRepository {
  constructor(private db: D1Database) {}

  async create(key: ApiKey): Promise<void> {
    await this.db
      .prepare("INSERT INTO api_keys (id, user_id, key_hash, created_at) VALUES (?, ?, ?, ?)")
      .bind(key.id, key.userId, key.keyHash, key.createdAt)
      .run();
  }

  async findByKeyHash(hash: string): Promise<ApiKey | null> {
    const row = await this.db
      .prepare("SELECT id, user_id, key_hash, created_at FROM api_keys WHERE key_hash = ?")
      .bind(hash)
      .first();
    if (!row) return null;
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      userId: r.user_id as string,
      keyHash: r.key_hash as string,
      createdAt: r.created_at as string,
    };
  }
}
