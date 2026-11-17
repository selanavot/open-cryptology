# Withdrawn papers and version history

## Withdrawn papers

ePrint keeps a withdrawn paper's abstract page (title, authors and affiliations, abstract,
category, license, history ending in "YYYY-MM-DD: withdrawn") and shows
"Available format(s): -- withdrawn --". The mirror does the same:

- `/YYYY/NNNN` answers 200 with the full metadata, a notice "Withdrawn by the authors on ePrint on
  YYYY-MM-DD", "-- withdrawn --" under Available format(s) and, if we hold one, the last PDF
  (labelled withdrawn). Without a copy, the page asks for an upload of the latest version from ePrint's version
  list (`/archive/versions/YYYY/NNNN/`); uploads go through the same checks as any other.
- `/YYYY/NNNN.pdf` serves that PDF (200) with `X-Withdrawn: 1`; 410 if we have no copy (with the
  upload URL, like the 404 for live papers).
- `/api/papers/YYYY/NNNN` answers 200 with `withdrawn: true`, `withdrawn_on`, `pdf.withdrawn`.
- Search and listings include withdrawn papers with a "withdrawn" badge (the homepage stats still
  count live papers only). Rows we know nothing about (empty title) stay out of listings.

Data: `papers.withdrawn_on` (YYYY-MM-DD) and `papers.affiliations` (JSON array parallel to
`authors`). OAI-PMH deleted records carry no metadata, so:

- `pipeline/harvest_oai.py` and `pipeline/harvest_remote.py`: a deleted record for an existing row only
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

### The backfill (November 2026, finished)

Older revisions were copied once from public copies, without PDFs passing through a laptop:
`pipeline/discover_versions.py` listed every Wayback capture of `eprint.iacr.org/YYYY/NNNN.pdf`
(CDX) and the GitHub-mirror snapshot of each paper, dropped digests we already held, and had a
temporary helper Worker (`versions-worker/`) fetch each remaining copy inside Cloudflare, check it
was a complete PDF (`worker/src/pdfcheck.ts`; many 2019-2025 Wayback captures are cut off at
1 MiB), hash it and store it in R2. Version rows were then inserted, and `papers.pdf_key` moved to
the newest version. `pipeline/repair_truncated.py` replaced truncated copies stored before the
check existed.

Result (2026-11-17): 13,489 older copies stored (11.2 GB); 40,344 versions for 28,582 papers,
8,963 of them with two or more. About 540 captures were rejected as incomplete or unreadable, and
639 were left uncopied: 609 from one 2008 Wayback crawl that the Archive would not serve to
Cloudflare (it serves them elsewhere), and 30 others that kept failing. Their list is in the
gitignored `data/versions/` of the run.

The helper Worker was deleted afterwards, and the scripts and helper were removed from the repo;
they are in git history (`git show b3f5337:pipeline/discover_versions.py`). New
revisions come in as uploads, which get `source='upload'` version rows.
