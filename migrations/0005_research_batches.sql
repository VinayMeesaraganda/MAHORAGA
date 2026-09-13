-- Freeze the ranked candidate set for a whole session, not just each event independently.
CREATE TABLE IF NOT EXISTS research_batches (
  id TEXT PRIMARY KEY, event_keys TEXT NOT NULL, created_at TEXT NOT NULL
);
