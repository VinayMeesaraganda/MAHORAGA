-- Append-only evidence/decisions. No reset or rewrite of trading history.
CREATE TABLE IF NOT EXISTS research_evidence (
  id TEXT PRIMARY KEY, source_url TEXT NOT NULL, content_hash TEXT NOT NULL,
  content TEXT NOT NULL, published_at TEXT NOT NULL, observed_at TEXT NOT NULL,
  UNIQUE(source_url, content_hash)
);
CREATE TABLE IF NOT EXISTS research_events (
  id TEXT PRIMARY KEY, event_key TEXT NOT NULL, version TEXT NOT NULL,
  symbol TEXT NOT NULL, payload TEXT NOT NULL, observed_at TEXT NOT NULL,
  UNIQUE(event_key, version)
);
CREATE INDEX IF NOT EXISTS research_events_time ON research_events(observed_at);
CREATE TABLE IF NOT EXISTS research_decisions (
  id TEXT PRIMARY KEY, experiment TEXT NOT NULL, event_key TEXT NOT NULL,
  session TEXT NOT NULL, input_json TEXT NOT NULL, result_json TEXT NOT NULL,
  profile_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(experiment, event_key, session)
);
CREATE TABLE IF NOT EXISTS research_news (
  id TEXT PRIMARY KEY, article_id TEXT NOT NULL, updated_at TEXT NOT NULL,
  content_hash TEXT NOT NULL, payload TEXT NOT NULL, observed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_coverage (
  stream TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reconciled_loss_fills (
  id TEXT PRIMARY KEY, symbol TEXT NOT NULL, order_id TEXT NOT NULL,
  cumulative_qty REAL NOT NULL, cumulative_proceeds REAL NOT NULL, loss_usd REAL NOT NULL, filled_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
