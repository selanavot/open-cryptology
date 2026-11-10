-- D1 (SQLite) schema. Source of truth for all metadata. Never commit data, only this schema.

CREATE TABLE IF NOT EXISTS papers (
  id              TEXT PRIMARY KEY,          -- 'YYYY/NNNN', e.g. '2024/123'
  year            INTEGER NOT NULL,
  num             INTEGER NOT NULL,
  title           TEXT NOT NULL,
  authors         TEXT NOT NULL,             -- JSON array of names
  abstract        TEXT,
  category        TEXT,                      -- from dc:subject
  license_url     TEXT,                      -- dc:rights, e.g. https://creativecommons.org/licenses/by/4.0/
  license_code    TEXT,                      -- normalized: 'CC BY', 'CC BY-NC', 'CC BY-NC-ND', 'CC BY-SA', 'CC BY-NC-SA', 'CC0', or NULL
  retro_license   INTEGER NOT NULL DEFAULT 0,-- 1 if posted before 2022 (license assigned retroactively by IACR)
  submitted       TEXT,                      -- first dc:date (ISO)
  updated         TEXT,                      -- OAI datestamp (ISO), last change on ePrint
  withdrawn       INTEGER NOT NULL DEFAULT 0,-- OAI deleted record
  -- mirrored PDF (NULL until ingested into R2)
  pdf_key         TEXT,                      -- R2 key, e.g. 'pdf/2024/123.pdf'
  pdf_sha256      TEXT,
  pdf_size        INTEGER,
  pdf_source      TEXT,                      -- 'github-mirror' | 'wayback' | 'upload' | 'other'
  pdf_source_date TEXT,                      -- when the source captured it (ISO)
  pdf_maybe_stale INTEGER NOT NULL DEFAULT 0 -- 1 if pdf_source_date < updated (a newer revision may exist)
);
CREATE INDEX IF NOT EXISTS papers_year ON papers(year, num);
CREATE INDEX IF NOT EXISTS papers_updated ON papers(updated);

-- Full-text search over metadata (external-content FTS5; rebuild after bulk loads with
-- INSERT INTO papers_fts(papers_fts) VALUES('rebuild');)
CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
  id UNINDEXED, title, authors, abstract,
  content='papers', content_rowid='rowid', tokenize='porter unicode61'
);

-- Candidate places a paper's PDF can be fetched from (discovered via listing APIs, no downloads).
CREATE TABLE IF NOT EXISTS sources (
  paper_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,                 -- 'github-mirror' | 'wayback' | 'arxiv' | 'oa'
  url         TEXT NOT NULL,
  captured_at TEXT,                          -- ISO; for wayback = capture timestamp
  size        INTEGER,
  PRIMARY KEY (paper_id, kind)
);

-- Crowdsourced uploads land in a quarantine R2 prefix until verified.
CREATE TABLE IF NOT EXISTS uploads (
  id          TEXT PRIMARY KEY,              -- random id
  paper_id    TEXT NOT NULL,
  r2_key      TEXT NOT NULL,                 -- 'quarantine/<id>.pdf'
  sha256      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  uploader    TEXT,                          -- later: GitHub login
  created_at  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted' | 'rejected'
  checks      TEXT                           -- JSON verification report
);
CREATE INDEX IF NOT EXISTS uploads_paper ON uploads(paper_id, status);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Cloud ingestion bookkeeping (cron in the Worker): failures back off per paper.
CREATE TABLE IF NOT EXISTS ingest_state (
  paper_id    TEXT PRIMARY KEY,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  last_source TEXT,
  next_try_at TEXT                            -- ISO; NULL = eligible now
);
