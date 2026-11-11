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
-- Papers still missing a PDF. Its only user, /api/missing, is gone (2026-11); kept to avoid a migration.
CREATE INDEX IF NOT EXISTS papers_missing ON papers(year DESC, num DESC) WHERE pdf_key IS NULL AND withdrawn = 0;

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
  checks      TEXT,                          -- JSON verification report
  ip_hash     TEXT                           -- salted hash of the uploader's IP (rate limiting)
);
CREATE INDEX IF NOT EXISTS uploads_paper ON uploads(paper_id, status);
CREATE INDEX IF NOT EXISTS uploads_created ON uploads(created_at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);


-- ---------------------------------------------------------------------------------------------
-- Withdrawn papers and version history (2026-11). Appended as ALTER/CREATE so existing databases
-- can be migrated with exactly these statements (see docs/VERSIONS.md); on a fresh database they
-- simply run after the CREATE TABLEs above. (Re-running the whole file on an already migrated
-- database stops at the first ALTER with "duplicate column"; everything before it is idempotent.)

-- Day the paper was withdrawn on ePrint (YYYY-MM-DD), from the abstract page's history, else the
-- OAI datestamp of the deleted record. NULL for live papers.
ALTER TABLE papers ADD COLUMN withdrawn_on TEXT;
-- JSON array parallel to `authors` (affiliation or null per author), when known. OAI-PMH has no
-- affiliations, so this is only filled where an abstract page was parsed (withdrawn backfill).
ALTER TABLE papers ADD COLUMN affiliations TEXT;

-- Every distinct PDF we hold for a paper. papers.pdf_key is the latest one (the default PDF).
-- R2 keys: the first mirrored copy keeps its original key 'pdf/YYYY/NNNN.pdf'; further versions
-- live at 'pdf/YYYY/NNNN/<stamp>.pdf' where stamp = captured_at as YYYYMMDDThhmmssZ.
CREATE TABLE IF NOT EXISTS versions (
  id          INTEGER PRIMARY KEY,
  paper_id    TEXT NOT NULL,
  stamp       TEXT NOT NULL,                 -- captured_at as YYYYMMDDThhmmssZ (URL: /YYYY/NNNN/versions/<stamp>.pdf)
  r2_key      TEXT NOT NULL UNIQUE,
  sha256      TEXT,                          -- hex; NULL until hashed
  sha1        TEXT,                          -- base32 SHA-1 (same form as Wayback CDX digests), for dedup
  size        INTEGER,
  source      TEXT NOT NULL,                 -- 'github-mirror' | 'wayback' | 'upload'
  source_url  TEXT,
  captured_at TEXT NOT NULL,                 -- ISO; when the source captured this content
  added_at    TEXT NOT NULL,                 -- ISO; when it was added to the mirror
  UNIQUE (paper_id, stamp),
  UNIQUE (paper_id, sha256)
);
CREATE INDEX IF NOT EXISTS versions_paper ON versions(paper_id, captured_at);

-- ---------------------------------------------------------------------------------------------
-- ePrint's current PDF size (2026-11), from its RSS feed (<enclosure length>), recorded by the
-- harvest (pipeline/harvest_remote.py). OAI-PMH can't tell a new PDF from a metadata-only edit
-- (e.g. publication info); the size can: pdf_maybe_stale = (pdf_size != pdf_latest_size).
-- pdf_latest_at = the OAI datestamp (papers.updated) the size belongs to; a size recorded before
-- a later change (pdf_latest_at < updated) is not used.
ALTER TABLE papers ADD COLUMN pdf_latest_size INTEGER;
ALTER TABLE papers ADD COLUMN pdf_latest_at TEXT;
