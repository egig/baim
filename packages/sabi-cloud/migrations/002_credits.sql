ALTER TABLE api_keys ADD COLUMN credit_balance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN api_key_id TEXT;
CREATE INDEX IF NOT EXISTS idx_jobs_api_key_id ON jobs(api_key_id);

CREATE TABLE IF NOT EXISTS credit_ledger (
    id TEXT PRIMARY KEY,
    key_id TEXT NOT NULL REFERENCES api_keys(id),
    job_id TEXT,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('charge', 'refund', 'grant')),
    created_at TEXT NOT NULL,
    UNIQUE (job_id, reason)
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_key_id ON credit_ledger(key_id);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_job_id ON credit_ledger(job_id);
