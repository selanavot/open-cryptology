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

-- ---------------------------------------------------------------------------------------------
-- accounts (2026-11): sign-in with GitHub, Google or ORCID (worker/src/auth.ts, docs/ACCOUNTS.md).
-- Only CREATE ... IF NOT EXISTS, so this section can be run on its own on an existing database:
--   sed -n '/^-- accounts/,$p' db/schema.sql > /tmp/accounts.sql   (then wrangler d1 execute)
-- Owned by auth.ts; other features reference users.id only.

-- A person. Content points at users.id (internal; never shown on a page). A deleted account stays
-- as a tombstone. The name shown is custom_name, else the name from the person's ORCID, Google or
-- GitHub account (identities.name); names needn't be unique. The maintainer role isn't stored: it
-- follows MAINTAINER_GITHUB_IDS and the GitHub log-in.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,            -- random, lowercase base32
  custom_name   TEXT,                        -- the person's own name for themselves, or NULL
  created_at    TEXT NOT NULL,
  deleted_at    TEXT,                        -- set = tombstone
  merged_into   TEXT                         -- tombstone of a merge: its content is credited to this user
);

-- A verified log-in method (GitHub account, Google account, ORCID iD) belonging to one user.
-- A user can have several. Only ever added, or moved over when two accounts are merged.
CREATE TABLE IF NOT EXISTS identities (
  provider            TEXT NOT NULL,         -- 'github' | 'google' | 'orcid' (no CHECK, so more can be added)
  provider_user_id    TEXT NOT NULL,         -- GitHub numeric id / Google sub / ORCID iD (stable; never a login or email)
  user_id             TEXT NOT NULL,
  handle              TEXT NOT NULL,         -- GitHub login / Google email domain / ORCID iD; refreshed at each sign-in
  url                 TEXT NOT NULL,         -- https://github.com/<login> | https://orcid.org/<iD> | '' for Google
  name                TEXT,                  -- the person's name there; refreshed at each log-in
  avatar              TEXT,                  -- profile photo URL (GitHub, Google), or ''
  created_at          TEXT NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS identities_user ON identities(user_id);

-- Browser sessions. The cookie holds a random token; only its SHA-256 is stored.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,              -- hex SHA-256 of the cookie token
  user_id     TEXT NOT NULL,
  created_at  TEXT NOT NULL,                 -- sessions end 180 days after this at the latest
  expires_at  TEXT NOT NULL,                 -- sliding: pushed out when last_seen is refreshed
  last_seen   TEXT NOT NULL                  -- written at most once an hour
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- A merge offered on /account/merge: the signed-in user added a sign-in that belongs to another
-- account. Valid for 10 minutes; the browser holds the token in a cookie, D1 only its SHA-256.
CREATE TABLE IF NOT EXISTS pending_merges (
  id                TEXT PRIMARY KEY,        -- hex SHA-256 of the cookie token
  user_id           TEXT NOT NULL,           -- the signed-in account (kept)
  other_user_id     TEXT NOT NULL,           -- the account to merge in
  provider          TEXT NOT NULL,           -- the sign-in that was just used
  provider_user_id  TEXT NOT NULL,
  expires_at        TEXT NOT NULL
);

-- original manuscripts (2026-11): worker/src/manuscripts.ts. Only CREATE ... IF NOT EXISTS, so this
-- section can be run on its own:  sed -n '/^-- original manuscripts/,$p' db/schema.sql
-- Ids are the UTC date of first publication plus that day's number ('2026-11-15/3'); numbers are
-- never reused, so removed manuscripts keep their row.
CREATE TABLE IF NOT EXISTS manuscripts (
  id                TEXT PRIMARY KEY,        -- '2026-11-15/3'
  day               TEXT NOT NULL,           -- '2026-11-15' (UTC)
  num               INTEGER NOT NULL,        -- 1, 2, ... within the day
  uploader_id       TEXT NOT NULL,           -- users.id (shown as "uploaded by", never as an id)
  created_at        TEXT NOT NULL,
  withdrawn_at      TEXT,                    -- set by the uploader; versions stay readable
  withdrawn_reason  TEXT,
  removed_at        TEXT,                    -- set by a maintainer; content is deleted
  removed_by        TEXT,
  UNIQUE (day, num)
);
CREATE INDEX IF NOT EXISTS manuscripts_uploader ON manuscripts(uploader_id, created_at);
CREATE INDEX IF NOT EXISTS manuscripts_created ON manuscripts(created_at);

-- Every version of a manuscript (v1, v2, ...). PDFs live in R2 (file_key, under manuscripts/);
-- body is for Markdown manuscripts, which were tried and dropped for now: posts are PDFs only.
CREATE TABLE IF NOT EXISTS manuscript_versions (
  manuscript_id     TEXT NOT NULL,
  v                 INTEGER NOT NULL,
  title             TEXT NOT NULL,
  authors           TEXT NOT NULL,           -- JSON array, as they should be cited
  abstract          TEXT NOT NULL,
  format            TEXT NOT NULL,           -- 'md' | 'pdf'
  body              TEXT,                    -- the Markdown source (format 'md')
  file_key          TEXT,                    -- R2 key (format 'pdf')
  sha256            TEXT NOT NULL,
  size              INTEGER NOT NULL,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (manuscript_id, v)
);

-- agent API (2026-11): worker/src/agentapi.ts. An agent asks to connect (OAuth device flow), the
-- person approves it with one click, and the agent receives a token. Only CREATE ... IF NOT EXISTS,
-- so this section can be run on its own:  sed -n '/^-- agent API/,$p' db/schema.sql
-- A token lets an agent post original manuscripts as one person. Only its SHA-256 is stored.
CREATE TABLE IF NOT EXISTS api_tokens (
  id            TEXT PRIMARY KEY,            -- random; also recorded on what the token posted
  hash          TEXT NOT NULL UNIQUE,        -- hex SHA-256 of the token
  user_id       TEXT NOT NULL,               -- users.id (moved to the kept account on a merge)
  scopes        TEXT NOT NULL,               -- space-separated; 'manuscripts' (post and read them)
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,               -- short-lived, like a browser login
  revoked_at    TEXT                         -- account deleted, a maintainer cut it off, or replaced
);
CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens(user_id);

-- An agent asking to connect. The token is minted when the agent collects it after approval, so
-- no token secret is ever stored. Rows older than a day are deleted when new requests come in.
CREATE TABLE IF NOT EXISTS agent_connect (
  id            TEXT PRIMARY KEY,            -- hex SHA-256 of the agent's device_code
  user_code     TEXT NOT NULL UNIQUE,        -- 'WXYZ2345', shown as WXYZ-2345 and in the approve link
  ip_hash       TEXT NOT NULL,
  country       TEXT,                        -- where the request came from (CF-IPCountry), shown on the approve page
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied | claimed
  user_id       TEXT,                        -- who approved or denied it
  token_id      TEXT                         -- the token handed out (replaced if the agent asks again)
);
CREATE INDEX IF NOT EXISTS agent_connect_ip ON agent_connect(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS agent_connect_created ON agent_connect(created_at);
-- Posting checks the site's daily total and finds the version it just stored by its file.
CREATE INDEX IF NOT EXISTS manuscript_versions_created ON manuscript_versions(created_at);
CREATE INDEX IF NOT EXISTS manuscript_versions_file ON manuscript_versions(file_key);

-- Which token (if any) posted each manuscript: for moderation only, never shown.
CREATE TABLE IF NOT EXISTS manuscript_tokens (
  manuscript_id TEXT PRIMARY KEY,
  token_id      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS manuscript_tokens_token ON manuscript_tokens(token_id);

-- comments (2026-11): worker/src/comments.ts. Only CREATE ... IF NOT EXISTS, so this section can be
-- run on its own:  sed -n '/^-- comments (2026-11)/,$p' db/schema.sql
-- One table for comments on ePrint papers and original manuscripts, with nested replies.
-- Rows are never deleted: deleting your own comment erases its text, a maintainer's hide keeps it.
CREATE TABLE IF NOT EXISTS comments (
  id            INTEGER PRIMARY KEY,
  target        TEXT NOT NULL,               -- '2024/123' (ePrint paper) or '2026-11-15/3' (manuscript)
  user_id       TEXT NOT NULL,               -- users.id (publicUsers follows merges)
  reply_to      INTEGER,                     -- the comment replied to, on the same target
  body          TEXT NOT NULL,               -- plain text with $TeX$; '' once its author deletes it
  state         TEXT NOT NULL DEFAULT 'visible', -- visible | deleted (by its author) | hidden (by a maintainer)
  moderated_by  TEXT,
  token_id      TEXT,                        -- api_tokens.id if an agent posted it: for moderation only, never shown
  created_at    TEXT NOT NULL,
  edited_at     TEXT                         -- last edit by its author (earlier text isn't kept)
);
CREATE INDEX IF NOT EXISTS comments_target ON comments(target, created_at);
CREATE INDEX IF NOT EXISTS comments_user ON comments(user_id, created_at);

-- comment types and votes (2026-11): worker/src/comments.ts. Run on an existing database with:
--   sed -n '/^-- comment types and votes/,$p' db/schema.sql
-- (the two ALTERs fail with "duplicate column" if run twice; the CREATEs are idempotent).
-- A top-level comment is a post with a title and an optional label (kind; 'comment' is none);
-- replies are always 'comment' and have no title.
ALTER TABLE comments ADD COLUMN kind TEXT NOT NULL DEFAULT 'comment';  -- 'comment' | 'issue' | 'question' | 'extension'
ALTER TABLE comments ADD COLUMN title TEXT;                            -- top-level posts

-- One vote per person per comment: 1 (up) or -1 (down). Pages show only the sum; who voted is
-- never shown. Only people vote (no agent API), and an account's votes go when it is deleted.
CREATE TABLE IF NOT EXISTS comment_votes (
  comment_id  INTEGER NOT NULL,
  user_id     TEXT NOT NULL,
  vote        INTEGER NOT NULL,              -- 1 | -1
  created_at  TEXT NOT NULL,
  PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX IF NOT EXISTS comment_votes_user ON comment_votes(user_id, created_at);

-- Bot profiles: apply the following ALTER statements once before deploying bot account support.
-- NULL for people; a bot's public bio is plain text (possibly empty).
ALTER TABLE users ADD COLUMN bot_bio TEXT;
ALTER TABLE users ADD COLUMN bot_avatar BLOB; -- optional small JPEG supplied by the operator

-- issue severity (2026-11): worker/src/comments.ts, levels in worker/src/severity.ts. Run on an
-- existing database with:  sed -n '/^-- issue severity/,$p' db/schema.sql
-- (the ALTER fails with "duplicate column" if run twice). 'critical' | 'high' | 'medium' | 'low' on
-- top-level Issues, NULL otherwise (and on Issues from before severities). The levels are a list in
-- code, not a CHECK here, because the rubric will change.
ALTER TABLE comments ADD COLUMN severity TEXT;

-- manuscript author ids (2026-11): worker/src/manuscripts.ts. Run on an existing database with:
--   sed -n '/^-- manuscript author ids/,$p' db/schema.sql
-- (the ALTER fails with "duplicate column" if run twice; the CREATEs are idempotent).
-- The uploader may give each author an ORCID iD and an email (optional), so that people who sign
-- in with them can later be recognized as authors. Neither is verified when posted.
-- JSON array parallel to `authors`: an ORCID iD or null. NULL = none given. Shown on the page.
ALTER TABLE manuscript_versions ADD COLUMN author_orcids TEXT;
-- Authors' emails, per version. Personal data: never shown on a page or in the API; kept apart from
-- manuscript_versions so a SELECT * there can't carry them.
CREATE TABLE IF NOT EXISTS manuscript_author_emails (
  manuscript_id TEXT NOT NULL,
  v             INTEGER NOT NULL,
  position      INTEGER NOT NULL,            -- index into manuscript_versions.authors
  email         TEXT NOT NULL,               -- lowercased
  PRIMARY KEY (manuscript_id, v, position)
);
CREATE INDEX IF NOT EXISTS manuscript_author_emails_email ON manuscript_author_emails(email);

-- account emails (2026-11): worker/src/auth.ts. Run on an existing database with:
--   sed -n '/^-- account emails/,$p' db/schema.sql
-- (idempotent). The email each log-in method vouches for: Google's, GitHub's primary verified
-- email (scope user:email), or the ORCID record's public verified email. Refreshed at each sign-in.
-- Personal data: never shown except to its owner on /account; kept apart from identities so a
-- SELECT * there can't carry it. Keyed like identities, so it follows them through merges.
CREATE TABLE IF NOT EXISTS identity_emails (
  provider          TEXT NOT NULL,
  provider_user_id  TEXT NOT NULL,
  email             TEXT NOT NULL,           -- lowercased
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS identity_emails_email ON identity_emails(email);

-- moderation (2026-11): worker/src/moderation.ts. Run on an existing database with:
--   sed -n '/^-- moderation (2026-11)/,$p' db/schema.sql
-- (the ALTER at the end fails with "duplicate column" if run twice; the CREATEs are idempotent).

-- A report from a signed-in person about a comment, an original manuscript or an account. One open
-- report per person per thing. Closed when a maintainer acts on it or dismisses it; kept after.
CREATE TABLE IF NOT EXISTS reports (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,                -- 'comment' | 'manuscript' | 'user'
  target       TEXT NOT NULL,                -- comments.id, manuscripts.id or users.id
  reporter_id  TEXT NOT NULL,                -- users.id
  reason       TEXT NOT NULL,                -- 'spam' | 'abuse' | 'other'
  note         TEXT,                         -- the reporter's words, optional
  snapshot     TEXT,                         -- what was reported, as it read then (survives edits and deletion)
  created_at   TEXT NOT NULL,
  closed_at    TEXT,
  closed_by    TEXT,                         -- the maintainer
  outcome      TEXT                          -- 'actioned' | 'dismissed'
);
CREATE UNIQUE INDEX IF NOT EXISTS reports_once ON reports(kind, target, reporter_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS reports_open ON reports(closed_at, created_at);
CREATE INDEX IF NOT EXISTS reports_reporter ON reports(reporter_id, created_at);

-- Every maintainer action: who did what to which thing, and whose it was. Never shown publicly.
CREATE TABLE IF NOT EXISTS mod_log (
  id       INTEGER PRIMARY KEY,
  at       TEXT NOT NULL,
  by       TEXT NOT NULL,                    -- the maintainer's users.id
  action   TEXT NOT NULL,                    -- hide | unhide | remove | suspend | unsuspend | reset_name | dismiss | clear_history
  kind     TEXT NOT NULL,                    -- 'comment' | 'manuscript' | 'user'
  target   TEXT NOT NULL,
  subject  TEXT,                             -- the account it concerns (author, uploader, the account itself)
  note     TEXT
);
CREATE INDEX IF NOT EXISTS mod_log_subject ON mod_log(subject, at);
CREATE INDEX IF NOT EXISTS mod_log_target ON mod_log(kind, target, at);

-- A comment's earlier text, saved each time its author edits it. Public (/comments/<id>/history);
-- deleted with the comment's text when its author deletes it, or by a maintainer (clear_history).
CREATE TABLE IF NOT EXISTS comment_revisions (
  comment_id  INTEGER NOT NULL,
  replaced_at TEXT NOT NULL,                 -- when this text was replaced by the next
  kind        TEXT NOT NULL,
  title       TEXT,
  severity    TEXT,
  body        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comment_revisions_comment ON comment_revisions(comment_id, replaced_at);

-- Set while a maintainer has suspended the account: it can still sign in, read, delete its own
-- comments and delete itself, but not post, edit, vote, rename, merge or use agents.
ALTER TABLE users ADD COLUMN suspended_at TEXT;
