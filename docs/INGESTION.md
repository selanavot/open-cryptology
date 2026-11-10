# Ingestion

How metadata and PDFs get into D1 and R2 in production. Local development uses the Python
pipeline against Wrangler's emulated D1/R2 instead (`pipeline/README.md`).

## Metadata (live)

- **Initial load:** `pipeline/harvest_oai.py` (full OAI-PMH ListRecords, written to remote D1).
- **Updates:** the site Worker's Cron Trigger runs every 4 hours (`17 */4 * * *`,
  `worker/src/harvest.ts`): incremental `ListRecords&from=<meta.last_harvest>`, at most 3 pages
  per run, >= 3 s between pages, descriptive User-Agent, stops at the first 403/429 and tries
  again next run (no workarounds if blocked). Upserts touch metadata columns only, never move a
  record backwards in time (`excluded.updated >= papers.updated`) and never touch `pdf_*`.
  Kept rare to be polite to IACR. Kill switch: `HARVEST_ENABLED != "1"`.
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
- **Uploads:** anyone can upload a PDF for a paper that lacks an up-to-date copy; it lands in
  `quarantine/` and is published only after it is verified against the paper's metadata.
- **Staleness:** `pdf_maybe_stale = 1` when the stored copy predates the paper's OAI `updated`
  datestamp (conservative: the datestamp also moves on some metadata-only edits). The page and
  the PDF response then say the copy may be an older revision; the upload endpoint accepts a
  newer copy for such papers.

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
