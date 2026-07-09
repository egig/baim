import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashKey } from "../src/application/hash-key";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Args {
  credits: number;
  userId: string | null;
  remote: boolean;
}

function parseArgs(argv: string[]): Args {
  let credits: number | null = null;
  let userId: string | null = null;
  let remote = false;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--credits":
        credits = Number(argv[++i]);
        break;
      case "--user":
        userId = argv[++i];
        break;
      case "--remote":
        remote = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  if (credits === null || !Number.isInteger(credits) || credits <= 0) {
    throw new Error("Usage: mint-key --credits <positive integer> [--user <existing user id>] [--remote]");
  }
  if (userId !== null && !UUID_RE.test(userId)) {
    throw new Error(`--user must be a UUID, got: ${userId}`);
  }

  return { credits, userId, remote };
}

async function main(): Promise<void> {
  const { credits, userId: existingUserId, remote } = parseArgs(process.argv.slice(2));

  const userId = existingUserId ?? crypto.randomUUID();
  const rawKey = crypto.randomUUID();
  const keyHash = await hashKey(rawKey);
  const apiKeyId = crypto.randomUUID();
  const ledgerId = crypto.randomUUID();
  const now = new Date().toISOString();

  // All interpolated values are either script-generated UUIDs/hex hashes or a
  // --user value already validated against UUID_RE above — none are free-text.
  const statements: string[] = [];
  if (!existingUserId) {
    statements.push(`INSERT INTO users (id, created_at) VALUES ('${userId}', '${now}');`);
  }
  statements.push(
    `INSERT INTO api_keys (id, user_id, key_hash, credit_balance, created_at) VALUES ('${apiKeyId}', '${userId}', '${keyHash}', ${credits}, '${now}');`
  );
  statements.push(
    `INSERT INTO credit_ledger (id, key_id, job_id, delta, reason, created_at) VALUES ('${ledgerId}', '${apiKeyId}', NULL, ${credits}, 'grant', '${now}');`
  );

  const sqlPath = join(tmpdir(), `mint-key-${apiKeyId}.sql`);
  writeFileSync(sqlPath, statements.join("\n"));

  try {
    const flag = remote ? "--remote" : "--local";
    execSync(`npx wrangler d1 execute sabi-db ${flag} --file=${sqlPath}`, { stdio: "inherit" });
  } finally {
    unlinkSync(sqlPath);
  }

  console.log("\n=== Credit key minted — this raw key will not be shown again ===");
  console.log(`API key:     ${rawKey}`);
  console.log(`User ID:     ${userId}`);
  console.log(`API key ID:  ${apiKeyId}`);
  console.log(`Credits:     ${credits}`);
  console.log(`Target:      ${remote ? "remote (production)" : "local"}`);
  console.log("===================================================================\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
