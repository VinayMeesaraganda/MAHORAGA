CREATE TABLE IF NOT EXISTS consensus_snapshots (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, symbol TEXT NOT NULL,
  report_date TEXT NOT NULL, fiscal_year INTEGER, fiscal_quarter INTEGER,
  payload TEXT NOT NULL, observed_at TEXT NOT NULL, evidence_id TEXT NOT NULL,
  prospective INTEGER NOT NULL CHECK(prospective IN (0,1))
);
CREATE INDEX IF NOT EXISTS consensus_lookup ON consensus_snapshots(symbol, report_date, observed_at);
CREATE TABLE IF NOT EXISTS experiment_audit (
  id TEXT PRIMARY KEY, experiment TEXT NOT NULL, kind TEXT NOT NULL,
  payload TEXT NOT NULL, observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS experiment_audit_time ON experiment_audit(experiment, observed_at);
CREATE TABLE IF NOT EXISTS broker_order_snapshots (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, order_id TEXT NOT NULL,
  payload TEXT NOT NULL, observed_at TEXT NOT NULL
);
