# Full ingestion plan (no laptop)

Status: plan. Locally we only run the Python pipeline against Wrangler's emulated D1/R2 with a
~20-PDF sample (`pipeline/README.md`). This document describes how the full archive gets into
R2 and stays current, entirely in the cloud.

## Numbers this plan is sized against (measured 2026-11-10)

| | |
|---|---|
| OAI records | 28,512 (839 deleted/withdrawn), 58 ListRecords pages of 500 |
| Metadata in D1 | ~35 MB abstracts + titles/authors + FTS index, well under the 500 MB Free D1 limit |
| GitHub mirror (`arturo-kong/IACR-eprint-mirror`) | 25,766 PDFs (incl. 113 for withdrawn papers), **19.6 GB**, mean ~760 KB; last push 2026-05-12; covers 100% of 1996-2025 except `1997/015` (PostScript), 27% of 2026 |
| Wayback CDX | latest PDF capture (incl. digest-matched revisits) for 26,737 papers; newest capture 2026-10-04 (IA's index lags weeks); 168 CDX pages for `eprint.iacr.org/`, ~35 s each -> ~2 h to list |
| Coverage of 27,673 live papers | any source 96.1% (100% for 1996-2025 except `1997/015`, 61% of 2026); fresh (captured at/after OAI `updated`) 93.2%; GitHub alone 92.7% / 87.2% fresh |

## Cloudflare limits that shape the design (checked against developers.cloudflare.com, 2026-11-10)

| Limit | Free | Paid ($5/mo) |
|---|---|---|
| Worker CPU per Cron Trigger | 10 ms | 30 s (interval < 1 h), 15 min (interval >= 1 h) |
| Worker CPU per Queue consumer invocation | - | 30 s default, up to 5 min (`limits.cpu_ms`) |
| Wall clock, cron or queue consumer | 15 min | 15 min |
| Subrequests per invocation | 50 | 10,000 default |
| Simultaneous open connections | 6 | 6 |
| Memory per isolate | 128 MB | 128 MB |
| Queues: max consumer batch / batch wait | 100 msgs / 60 s | same |
| Queues: `sendBatch` | 100 msgs or 256 KB | same |
| Queues: operations | 10,000/day | 1M/month incl., then $0.40/M (~3 ops per delivered message) |
| Queues: retention | 24 h | up to 14 days |
| Queues: `delaySeconds` | up to 24 h | same |
| D1 DB size / statement length / queries per invocation | 500 MB / 100 KB / 50 | 10 GB / 100 KB / 1,000 |
| R2 free tier | 10 GB-month, 1M Class A, 10M Class B, free egress | $0.015/GB-month beyond |
| R2 same-key writes | 1/s | 1/s |

Consequences:
- **Storage**: 19.6 GB of PDFs exceeds R2's 10 GB free tier: expect ~$0.15/month for the overage.
  Class A ops for ~28k puts are negligible.
- **Workers Paid is effectively required** for a Queue-based ingest: Free queues allow 10k ops/day
  (~3.3k PDFs/day) and Free crons get 10 ms CPU, which is too little to SHA-256 a large PDF.
  On Free, a minutely cron doing ~10 GitHub fetches each would still need ~2-3 days and would
  hit the CPU cap on big files.

## Architecture (recommended: Cron Trigger + two Queues, Workers Paid)

```
              daily cron (03:17 UTC)                       queue: ingest-github  (max_concurrency 1)
OAI-PMH ──► harvest(from=meta.last_harvest) ──► D1 ──► planner ──► queue: ingest-wayback (max_concurrency 1)
                                                                          │
                                       consumer: fetch source ─► verify ─► R2 put ─► D1 update
```

A separate Worker (`ingest/`, not the public site) with bindings `DB`, `PDFS`, the two queue
producers and their consumer handlers.

### 1. Daily metadata harvest (cron `scheduled()`)

- `GET https://eprint.iacr.org/oai?verb=ListRecords&metadataPrefix=oai_dc&from=<meta.last_harvest>`,
  follow `resumptionToken`; one client, >= 3 s between requests, descriptive User-Agent; stop at the
  first 403/429 (no retry; try again next day), patient backoff only on 5xx.
  A normal day is 1-3 pages (a few hundred records), i.e. well under a minute wall clock and
  a few ms CPU per page of XML parsing on Paid.
- Upsert exactly like `pipeline/harvest_oai.py`: metadata columns only, guarded by
  `excluded.updated >= papers.updated`, never touching `pdf_*`. Use `db.batch()` with
  ~50 statements per batch (one batch counts as one query against the per-invocation limit).
- `INSERT INTO papers_fts(papers_fts) VALUES('rebuild')` after the batch (seconds at this size;
  if it ever gets slow, switch to per-row FTS delete+insert triggers).
- Advance `meta.last_harvest` to the max datestamp seen only after the upserts succeed.
- **Blocked by Cloudflare?** On 2026-11-10 eprint.iacr.org started answering this laptop's
  harvester with a Cloudflare "Sorry, you have been blocked" 403 (an earlier full harvest from
  the same day worked). We do not work around blocks. If the Worker's requests are blocked too,
  the harvest fails loudly (alert, `meta.last_harvest` unchanged) and we ask IACR (robots.txt
  names a contact for metadata questions) to allowlist the harvester's User-Agent. The RSS/Atom
  feeds are a documented alternative if OAI is unavailable.

### 2. Planner (same cron, after the harvest)

For every live paper that needs a PDF, pick the best source and enqueue one message
`{id, url, kind, captured_at, updated}`:

- needs a PDF: `pdf_key IS NULL`, or `pdf_maybe_stale = 1` and some source has
  `captured_at > pdf_source_date`.
- best source (same rule as `ingest_sample.py`): fresh (`captured_at >= updated`) beats stale;
  GitHub beats Wayback (faster, not throttled); then newest capture.
- route to `ingest-github` or `ingest-wayback` by `kind`; `sendBatch` 100 messages at a time.
- mark `meta.ingest_planned_at` and never enqueue a paper that is already in flight (a small
  `ingest_state` column or table, see "Schema changes").
- Initial backfill: ~25k GitHub + ~2-3k Wayback messages, i.e. ~290 `sendBatch` calls; fine in
  one cron run on Paid (10k subrequests).

### 3. Consumers (streaming source -> R2)

Per message:
1. `fetch(url)` with the project User-Agent. Reject non-200, `Content-Length` > 20 MB.
2. Read the body into memory (<= 20 MB, well inside 128 MB), check `%PDF-` magic, compute
   SHA-256 with `crypto.subtle.digest` (a few ms of CPU per MB).
3. `PDFS.put('pdf/YYYY/NNNN.pdf', body, { httpMetadata: { contentType: 'application/pdf' },
   customMetadata: { source, source_date, sha256 } })`.
4. `UPDATE papers SET pdf_key, pdf_sha256, pdf_size, pdf_source, pdf_source_date,
   pdf_maybe_stale = (source_date < updated)` and clear the in-flight flag.
5. On failure: `msg.retry({ delaySeconds })` with exponential delay (60 s, 5 min, 30 min, ...);
   after ~5 attempts on the same source, let the planner choose the next source tomorrow
   (record the failure so the same source isn't retried forever). Queues allows up to 100 retries;
   configure a dead-letter queue for inspection.

Rate limits per source host, enforced by the queue config plus pacing inside the consumer
(sleeping costs wall clock, not CPU):

| Queue | Host | Settings | Pace | Backfill time |
|---|---|---|---|---|
| `ingest-github` | raw.githubusercontent.com | `max_batch_size` 50, `max_concurrency` 1 | ~1 req/s | ~26k PDFs -> **~7-8 h** |
| `ingest-wayback` | web.archive.org | `max_batch_size` 10, `max_concurrency` 1, `max_batch_timeout` 60 | 1 req / 5 s, back off 5-15 min on refusals/"Temporarily Offline" | ~1k PDFs not on GitHub + ~1.7k fresher than GitHub -> **~3-5 h** (longer if IA throttles) |

Each GitHub batch is ~50 s wall clock and ~50 x (fetch + put) subrequests; each Wayback batch
~60 s. Queue ops for the backfill: ~3 x 29k ≈ 90k, inside the 1M/month on Paid.
Use Wayback `id_` URLs (`/web/<ts>id_/<original>`) so IA returns the original bytes.

### 4. Staleness

- ePrint papers get revised; the OAI `updated` datestamp moves forward (also on some metadata-only
  edits, so "stale" is conservative).
- `pdf_maybe_stale = 1` whenever the stored copy's `pdf_source_date < updated`. The site shows
  "this copy may predate the latest revision; see the original on ePrint".
- After each harvest, for papers that just became stale, the planner does one CDX lookup per paper
  (`/cdx/search/cdx?url=eprint.iacr.org/YYYY/NNNN.pdf&filter=statuscode:200&fl=timestamp,length&limit=-1`,
  paced like the Wayback queue). A capture newer than `updated` -> enqueue a re-ingest.
- Re-run GitHub discovery weekly (`git/trees` per year dir; a few dozen API calls with a token)
  to pick up new pushes to the community mirror.
- We do not trigger Save Page Now or anything else that would make a third party fetch ePrint
  PDFs on our behalf. Fresh copies of new revisions can also come in via verified uploads.

### 5. Withdrawals

OAI reports a withdrawn paper as `<header status="deleted">` with no metadata. On the next harvest:
- `withdrawn = 1` (metadata already stored is kept for the tombstone page); the site serves a
  tombstone page and 410 for the PDF route immediately, regardless of R2 contents.
- The planner skips withdrawn papers; the cron deletes `pdf/YYYY/NNNN.pdf` from R2, NULLs the
  `pdf_*` columns and deletes the paper's `sources` rows (113 GitHub PDFs already exist for
  withdrawn papers; they are never ingested).
- If a paper is later reinstated (a non-deleted record with a newer datestamp), the upsert sets
  `withdrawn = 0` and the planner re-ingests it.

## Alternative: GitHub Action backfill

For the one-off 19.6 GB backfill a scheduled GitHub Actions workflow is simpler than Queues:
matrix over years (each job well under the 6 h job limit), stream each PDF with `curl` from the
GitHub mirror (or a `git clone --filter=blob:none` + sparse checkout of one year dir) into R2's
S3-compatible API (`aws s3 cp - s3://open-cryptology-pdfs/pdf/... --endpoint-url https://<acct>.r2.cloudflarestorage.com`),
then write the `pdf_*` columns with `wrangler d1 execute --remote --file`. Needs an R2 API token
and a D1-scoped API token as repository secrets. The daily incremental work (harvest, planner,
small re-ingests) still belongs in the Worker cron.

## Policy notes

- ePrint's robots.txt states that PDFs are under per-paper licenses and that training AI models
  on the PDFs is not allowed. The site's `llms.txt`/about page should relay this alongside each
  paper's license; the mirror serves PDFs for reading and citation, not as a training corpus.
- The GitHub mirror's README claims all papers are CC BY; we ignore that and use the per-paper
  license from OAI `dc:rights`.

## Schema changes this plan wants

- `papers.ingest_state TEXT` (`'queued' | 'failed:<reason>' | NULL`) and `papers.ingest_attempts INTEGER`,
  or a separate `ingest_jobs(paper_id PK, source_kind, url, state, attempts, last_error, updated_at)`.
- `sources.checked_at TEXT` (when discovery last saw it) and allowing several sources per kind
  (e.g. PK `(paper_id, kind, url)`) so older Wayback captures remain as fallbacks.
