# Ingestion

How metadata and PDFs get into D1 and R2 in production. Local development uses the Python
pipeline against Wrangler's emulated D1/R2 instead (`pipeline/README.md`).

## Metadata (live)

- **Initial load:** `pipeline/harvest_oai.py` (full OAI-PMH ListRecords, written to remote D1).
- **Updates:** GitHub Actions, every 8 hours (`.github/workflows/harvest.yml`, cron
  `23 */8 * * *`, also runnable by hand) runs `pipeline/harvest_remote.py`: incremental
  `ListRecords&from=<meta.last_harvest minus 30 days>` (a new paper's datestamp is its submission
  time, but it only appears in OAI once approved, often days later; harvesting strictly from the
  watermark missed such papers; records we already hold unchanged are skipped, so the look-back
  costs no D1 writes; the `lookback_days` workflow input does a longer catch-up), following
  resumptionTokens (<= 30 pages per run,
  >= 3 s between pages, one client, descriptive User-Agent), written straight to production D1
  through the Cloudflare D1 HTTP API with the same parsing and upsert as `worker/src/oai.ts`.
  Upserts touch metadata columns only, never move a record backwards in time
  (`excluded.updated >= papers.updated`) and never touch `pdf_*`. On success it advances
  `meta.last_harvest` and writes `meta.harvest_last_run` (JSON summary) and `meta.harvest_last_ok`.
  It runs on GitHub because ePrint's Cloudflare challenges requests from Cloudflare Workers.
  The Worker's own harvest (`worker/src/harvest.ts`) is kept but off (`HARVEST_ENABLED = "0"`).
  - **Secret:** repository secret `CLOUDFLARE_API_TOKEN`, a Cloudflare API token with
    *Account > D1 > Edit* on the maintainer's account (Settings > Secrets and variables > Actions).
  - **Failure alerts:** the script exits non-zero (and the run fails) on any HTTP status other
    than 200, a non-OAI body (Cloudflare challenge/block page: reported as "blocked"), an OAI error
    other than `noRecordsMatch`, or a D1 API error. GitHub emails the repo owner about failed
    scheduled runs only if *Settings > Notifications > Actions* is set to email with
    "Send notifications for failed workflows only" checked (github.com/settings/notifications).
    Note GitHub disables scheduled workflows after 60 days without repository activity.
  - **Staleness alarm:** the Worker cron (every 4 h, `worker/src/staleness.ts`) emails
    `CONTACT_TO` "[Open Cryptology] Metadata harvest is stale" when `meta.harvest_last_ok` is
    missing or older than 26 h, at most once per 24 h (`meta.harvest_stale_alert_at`).
- **On demand:** a paper page for an id not yet in D1 does a single OAI `GetRecord`
  (`worker/src/oai.ts`), so brand-new papers appear before the next cron run.

## PDFs

The cron does **not** fetch PDFs, and nothing fetches PDFs from eprint.iacr.org.

- **Prefill (one-off):** R2 was filled from existing public copies (the community GitHub mirror
  `arturo-kong/IACR-eprint-mirror` and Wayback Machine `id_` captures, as listed in `sources` by
  `pipeline/discover_sources.py`) by a temporary helper Worker that streams source -> R2 inside
  Cloudflare. Tooling: `prefill-worker/`, `pipeline/prefill_via_worker.py`,
  `pipeline/apply_prefill.py`, `pipeline/missing_report.py`; all to be removed after the backfill.
  It can be re-run occasionally to pick up new public copies.
- **Uploads:** anyone can upload a PDF for a paper that lacks an up-to-date copy (web form, or
  the agent API `POST /api/upload/YYYY/NNNN`). A file whose first two pages show the title and an
  author's name (`worker/src/match.ts`, measured with `pipeline/verify_bench.mjs`) goes live at
  once; any other well-formed PDF lands in `quarantine/` until the maintainer approves it at
  `/review` (behind Cloudflare Access; at most one summary email per 15 minutes).
- **Staleness:** `pdf_maybe_stale = 1` when the stored copy may predate ePrint's current PDF.
  The harvest sets it whenever a record's datestamp moves past our copy's capture date. The OAI
  datestamp also moves on metadata-only edits (publication info, typically on acceptance), and OAI
  can't tell them apart, so after the OAI step the harvest reads ePrint's RSS feed once: its 100
  most recently changed papers, each with `<enclosure length>` = the current PDF's byte size. The
  size is stored as `pdf_latest_size` (with `pdf_latest_at` = the datestamp it belongs to), and the
  flag becomes exactly "our size != ePrint's size" (same size: metadata-only edit, flag cleared).
  Checked on 2026-11-11: 36/36 unflagged copies matched ePrint's size; of 36 flagged ones changed
  in the last ~6 days, 3 were metadata-only. Older flags were resolved where an archived feed
  snapshot covers them (`pipeline/rss_backfill.py`; the feed has sizes since August 2026). ePrint's
  per-paper versions page labels "PDF update" vs metadata-only too, but answers GitHub Actions
  with a Cloudflare challenge, so we don't use it.
  Flagged papers are "may be outdated": yellow on the year pages; the paper page asks for the latest
  version ("ePrint has a newer PDF" when the size says so), and the upload endpoints accept one.
  An upload of exactly the copy we serve clears the flag unless ePrint's size says otherwise; an
  upload of a copy we hold as an older version is refused; an accepted upload whose size differs
  from ePrint's known current size stays flagged.

## Lessons and numbers

- **D1 free plan: 100k row writes/day.** The one-time bulk metadata import used ~219k, so bulk
  loads (metadata or `pdf_*` updates) must be split across days (`apply_prefill.py` writes in
  chunks for this reason) or run on Workers Paid.
- Sizes (2026-11-10): 28,512 OAI records (839 deleted/withdrawn); ~35 MB of metadata in D1; the
  GitHub mirror holds ~25.8k PDFs, 19.6 GB, so R2 storage exceeds the 10 GB free tier (a few
  cents a month). Some public copy exists for ~96% of live papers (100% of 1996-2025 except
  `1997/015`, which is PostScript).

## Policy notes

- ePrint's robots.txt says PDFs are under per-paper licenses and must not be used to train AI
  models. The mirror serves PDFs for reading and citation, and relays each paper's license.
- The GitHub mirror's README claims all papers are CC BY; we ignore that and use the per-paper
  license from OAI `dc:rights`.
- We never trigger Save Page Now or anything else that would make a third party fetch ePrint
  PDFs on our behalf.
