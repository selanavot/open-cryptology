# pipeline/

Python 3 (stdlib only) scripts that fill the **local** Wrangler D1/R2 emulation for the Worker in
`worker/`. Run them from the repo root with `python3 -I`. They shell out to
`npx --no-install wrangler` inside `worker/` (bindings `DB` and bucket `open-cryptology-pdfs`, `--local`
by default) and to `gh` for GitHub listings.

Nothing here writes data into git: generated SQL, caches and temp PDFs go under `data/`
(gitignored) and are deleted after use. Nothing here fetches PDFs from eprint.iacr.org.
In production, metadata stays current via `harvest_remote.py` on GitHub Actions every 4 h
(`.github/workflows/harvest.yml`, details in `docs/INGESTION.md`); how PDFs get
into R2 is described in `docs/INGESTION.md`.

| Script | Does | Network |
|---|---|---|
| `harvest_oai.py` | OAI-PMH ListRecords (oai_dc) -> `papers`, FTS rebuild, `meta.last_harvest` | eprint.iacr.org/oai, one client, >= 3 s/request, stops at first 403/429 |
| `harvest_remote.py` | production harvest (run by GitHub Actions): OAI-PMH ListRecords from `meta.last_harvest` -> remote D1 via the D1 HTTP API (same upsert as `worker/src/oai.ts`), `meta.harvest_last_run` / `harvest_last_ok`; exits non-zero on block pages, HTTP != 200, OAI or D1 errors. Env: `CLOUDFLARE_API_TOKEN` (D1 Edit), optional `OAI_BASE` | eprint.iacr.org/oai, one client, >= 3 s/page, <= 30 pages/run |
| `discover_sources.py` | where PDFs can be fetched -> `sources` (no downloads) + coverage table | `gh api`; web.archive.org CDX, >= 5 s/request |
| `ingest_sample.py` | ~20 PDFs -> local R2 `pdf/YYYY/NNNN.pdf` + `papers.pdf_*` (local dev only: the only way to get PDFs into the emulated R2, to exercise the PDF route and paper pages with a mirrored copy) | raw.githubusercontent.com, web.archive.org |
| `backfill_withdrawn.py` | metadata of withdrawn papers from archived ePrint abstract pages -> remote `papers` | web.archive.org, 2 clients >= 2 s apart (eprint.iacr.org with `--source eprint`: one client, >= 5 s) |
| `discover_versions.py` | every distinct PDF per paper -> R2 + `versions`, via the helper Worker `versions-worker/` | web.archive.org CDX >= 5 s/request; copies in Cloudflare, 2 Wayback fetchers >= 2 s apart, 2-5 min backoff |
| `verify_bench.mjs` | benchmark for upload verification (`worker/src/match.ts`): false-reject / false-accept rates on ~300 sampled papers vs the previous matcher (Node >= 23; usage in the file header) | opencryptology.org PDFs, <= 4 at a time, deleted after text extraction |
| `common.py` | polite HTTP GET (per-host spacing, backoff), SQL quoting, wrangler wrappers | |

## Usage

```sh
# 0. (once) local D1 schema
(cd worker && npx --no-install wrangler d1 execute DB --local --file ../db/schema.sql)

# 1. metadata
python3 -I pipeline/harvest_oai.py --from-dir /path/to/saved/oai   # load saved page*.xml (no network)
python3 -I pipeline/harvest_oai.py                                 # incremental from meta.last_harvest
python3 -I pipeline/harvest_oai.py --full --save-dir data/oai      # everything, keep the raw pages
#   --from/--until DATESTAMP, --dry-run, --chunk N (statements per SQL file, default 500)

# 2. sources (GitHub mirror ~1.5 min; Wayback CDX ~2 h: 168 pages of the paged CDX API, one
#    client, >= 5 s apart; reruns resume from data/cache/discover/ with --keep-cache)
python3 -I pipeline/discover_sources.py
python3 -I pipeline/discover_sources.py --skip-github --years 2025-2026 --keep-cache
python3 -I pipeline/discover_sources.py --stats-only

# 3. sample PDFs into local R2 (idempotent; tops up to -n)
python3 -I pipeline/ingest_sample.py --dry-run
python3 -I pipeline/ingest_sample.py
python3 -I pipeline/ingest_sample.py --ids 2024/123 --force

# checks
cd worker
npx --no-install wrangler d1 execute DB --local --command \
  "SELECT id FROM papers_fts WHERE papers_fts MATCH 'isogeny' LIMIT 3"
npx --no-install wrangler r2 object get open-cryptology-pdfs/pdf/2024/1731.pdf --local --file /tmp/x.pdf
```

## One-off tooling (historical; remove after the PDF backfill)

These drove the one-time prefill of R2 from public copies (community GitHub mirror, Wayback
Machine). They are not part of the regular pipeline and get deleted once the backfill is done.

| What | Does |
|---|---|
| `../prefill-worker/` | temporary Worker `open-cryptology-prefill`: copies PDFs from the allowed public mirrors into R2 inside Cloudflare (shared-key protected). Delete with `npx wrangler delete --name open-cryptology-prefill` |
| `prefill_via_worker.py` | sends (id, source URL) batches to that Worker; resumable results log. Env: `PREFILL_WORKER_URL` (defaults to the deployed Worker) |
| `apply_prefill.py` | writes the results into remote D1 `papers.pdf_*` in chunks (free-plan D1 write quota). Env: `CLOUDFLARE_ACCOUNT_ID` if your Wrangler login sees several accounts |
| `missing_report.py` | CSV of live papers still without a PDF after the prefill |

## Data notes

- `papers.id` keeps ePrint's own spelling (`1996/002`, `2024/048`, `2024/1731`); `num` is the integer.
- Upserts change metadata columns only and never move a record backwards in time
  (`excluded.updated >= papers.updated`); `pdf_*` columns are never touched by the harvest.
- OAI deleted records carry no metadata: a new one is inserted with `title=''`, `authors='[]'`,
  `withdrawn=1`; an existing paper keeps its metadata and PDFs and gets `withdrawn=1` and
  `withdrawn_on` (the record's datestamp, unless already known). `backfill_withdrawn.py` fills
  empty withdrawn rows from archived abstract pages (see `docs/VERSIONS.md`).
- `license_code` is derived from `dc:rights` (`CC BY`, `CC BY-SA`, `CC BY-NC`, `CC BY-NC-SA`,
  `CC BY-NC-ND`, `CC0`); `retro_license = year < 2022`.
- `sources` (one row per paper and kind):
  - `github-mirror`: `arturo-kong/IACR-eprint-mirror`. File names are not always zero-padded
    (`2023/2.pdf` is `2023/002`). `captured_at` = date of the earliest commit containing the
    file's current blob (exact per file, derived from the 32-commit history), i.e. when it was
    pushed, a little after it was downloaded. `tuxxy/IACR-eprint-mirror` is an older ancestor of
    the same history and adds nothing.
  - `wayback`: latest capture of `eprint.iacr.org/YYYY/NNNN.pdf` whose payload is a 200 PDF
    (a `warc/revisit` counts when its digest matches a PDF capture: IA stores unchanged
    re-crawls as revisits, and `id_` replay returns the original bytes). Listed with the CDX
    pagination API (168 pages, ~35 s each, ~2 h). `size` is the CDX `length` (approximate).
- "fresh" in the coverage table = a source captured at/after the OAI datestamp `updated`.
  The datestamp also moves on some metadata-only edits, so this is conservative.

## Known issues

- On 2026-11-10 eprint.iacr.org started answering this machine's harvester with a Cloudflare
  "you have been blocked" 403 for `/oai` (robots.txt still 200). `harvest_oai.py` stops cleanly
  (exit 2, nothing written) and does not try to get around it. The resumptionToken loop was
  verified against a local stub serving saved pages (`--oai-url http://127.0.0.1:PORT/oai`).
- web.archive.org CDX is slow and throttles (504s, HTML "Temporarily Offline", refused
  connections). `discover_sources.py` backs off up to 10-15 min and caches finished pages.
