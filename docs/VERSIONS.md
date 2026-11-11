# Withdrawn papers and version history

## Withdrawn papers

ePrint keeps a withdrawn paper's abstract page (title, authors and affiliations, abstract,
category, license, history ending in "YYYY-MM-DD: withdrawn") and shows
"Available format(s): -- withdrawn --". The mirror does the same:

- `/YYYY/NNNN` answers 200 with the full metadata, a notice "Withdrawn by the authors on ePrint on
  YYYY-MM-DD", "-- withdrawn --" under Available format(s) and, if we hold one, the last PDF
  (labelled withdrawn). No upload form (withdrawn papers don't accept uploads).
- `/YYYY/NNNN.pdf` serves that PDF (200) with `X-Withdrawn: 1`; 410 if we have no copy.
- `/api/papers/YYYY/NNNN` answers 200 with `withdrawn: true`, `withdrawn_on`, `pdf.withdrawn`.
- Search and listings include withdrawn papers with a "withdrawn" badge (the homepage stats still
  count live papers only). Rows we know nothing about (empty title) stay out of listings.

Data: `papers.withdrawn_on` (YYYY-MM-DD) and `papers.affiliations` (JSON array parallel to
`authors`). OAI-PMH deleted records carry no metadata, so:

- `worker/src/oai.ts` and `pipeline/harvest_oai.py`: a deleted record for an existing row only
  sets `withdrawn=1`, `updated` and `withdrawn_on` (= the record's datestamp unless a date is
  already known); metadata and PDFs stay. A live record for a withdrawn row clears `withdrawn_on`.
- `pipeline/backfill_withdrawn.py` filled the metadata of the rows that were already withdrawn
  when we first harvested (they were inserted empty). It reads the newest archived copy of the
  abstract page from the Wayback Machine (CDX lookup + `id_` replay; 2 clients, each >= 2 s apart,
  backing off on throttling), parsing both the 2022+ layout and the older one. `--source eprint` reads ePrint
  itself instead (>= 5 s apart, stops on the first 403) but on 2026-11-10 ePrint's Cloudflare
  answered this machine with a block page, so the Wayback copies were used. If a copy predates
  the withdrawal, `withdrawn_on` falls back to the OAI datestamp.

```sh
python3 -I pipeline/backfill_withdrawn.py --workers 2 --gap 2   # fetch + parse, resumable
python3 -I pipeline/backfill_withdrawn.py --retry-failed     # retry papers that failed
python3 -I pipeline/backfill_withdrawn.py --apply            # write to remote D1 (idempotent)
```

## Version history

ePrint papers get revised; public copies (Wayback captures, the community GitHub mirror) hold
different revisions. We keep every distinct file we can find.

Table `versions` (db/schema.sql): one row per distinct PDF of a paper: `paper_id`, `stamp`
(capture time as `YYYYMMDDThhmmssZ`), `r2_key`, `sha256`, `sha1` (base32, same form as Wayback
CDX digests), `size`, `source` (`github-mirror` | `wayback` | `upload`), `source_url`,
`captured_at`, `added_at`; unique per (paper, stamp) and (paper, sha256).

- R2 keys: the first mirrored copy keeps its key `pdf/YYYY/NNNN.pdf` (not moved; it gets a
  version row pointing at it). Further versions: `pdf/YYYY/NNNN/<stamp>.pdf`.
- `papers.pdf_key` stays the default PDF = the latest version.
- Versions are labelled by capture date ("copy captured 2024-03-02"), not ePrint version
  numbers, which public copies don't tell us. A Wayback version is dated by the earliest capture
  of that digest; since ePrint only ever serves the current revision, capture order = revision
  order.
- Routes: `/YYYY/NNNN/versions/<stamp>.pdf` (headers `X-Captured-At`, `X-Withdrawn` if
  applicable); the paper page lists versions newest first; the API has `versions: [...]`.

### How the backfill works (no PDFs on the laptop)

`pipeline/discover_versions.py`, stages (state in `data/versions/`, all resumable):

1. `list`: Wayback CDX listing of `eprint.iacr.org/` with the pagination API (~170 pages, one
   client, >= 5 s apart, cached per page in `data/cache/discover/`), filtered server-side to
   `/YYYY/NNNN.pdf` URLs with `fl=original,timestamp,length,mimetype,statuscode,digest`.
2. `existing`: the helper Worker hashes every PDF already in R2 at the legacy key (sha256 + sha1)
   and records it as a version (source/url/date from `papers.pdf_*`, or the prefill results file
   for rows not updated yet). Also fills `papers.pdf_sha256` where NULL.
3. `plan`: per paper, the distinct digests of 200 `application/pdf` captures, minus those we
   hold; plus the GitHub-mirror snapshot (from `sources`) unless GitHub is already a version.
4. `copy`: the helper Worker fetches each planned copy inside Cloudflare, checks `%PDF-`, hashes
   it, and stores it unless its sha256 is already held for that paper. GitHub items run in
   parallel batches; Wayback items with 2 fetchers, each >= 2 s apart. On 429/5xx, or when IA
   refuses the helper (521/522, dropped connections), all fetchers pause 2-5 min and the item is
   retried; items still failing are left for a later run (never recorded as permanent).
5. `apply`: inserts version rows for stored copies and moves `papers.pdf_key` to the newest
   version where it is newer than the current one (or none was set, e.g. withdrawn papers).

```sh
# temporary helper Worker (own shared key, kept in data/versions/.versions-key)
cd worker
npx --no-install wrangler deploy -c ../versions-worker/wrangler.jsonc
python3 -c "import secrets;print(secrets.token_urlsafe(32))" > ../data/versions/.versions-key
npx --no-install wrangler secret put VERSIONS_KEY --name open-cryptology-versions < ../data/versions/.versions-key
cd ..
python3 -I pipeline/discover_versions.py list
python3 -I pipeline/discover_versions.py existing --prefill-results data/prefill/results.jsonl
python3 -I pipeline/discover_versions.py plan
python3 -I pipeline/discover_versions.py copy        # long: hours; applies what it stored every 15 min
python3 -I pipeline/discover_versions.py apply       # incremental (only copies not yet applied)
# a copy started without checkpoints: re-apply every 15 min until it exits
#   python3 -I pipeline/discover_versions.py apply --watch 15 --until-pid <copy pid>
python3 -I pipeline/discover_versions.py stats
cd worker && npx --no-install wrangler delete --name open-cryptology-versions
```

Re-running later only copies what's new (the plan drops digests already held and keys already
copied). Uploads, once verified, should be added as `source='upload'` version rows the same way.
