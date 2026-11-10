# Architecture

Open Cryptology: an unofficial, non-commercial mirror of the Cryptology ePrint Archive that makes papers easy to
obtain and search for humans and AI assistants, while respecting each paper's license.

## Principles

- **Git holds code only.** No PDFs, no metadata dumps. Data lives in a database and a bucket.
- **Never crawl ePrint PDFs.** eprint.iacr.org/robots.txt disallows PDF crawling and PDFs are
  behind a Cloudflare challenge; we do not bypass it. PDFs come from existing public copies
  (community GitHub mirror, Wayback Machine, arXiv/open-access copies) and verified uploads.
- **Metadata from OAI-PMH** (`https://eprint.iacr.org/oai`, CC0), harvested incrementally with
  `from=<last datestamp>`, politely (≥1 s between requests).
- **No bulk data on laptops.** Locally we use Wrangler's emulated D1/R2 with a ~20-paper PDF
  sample. Full ingestion runs in the cloud and streams source → R2.
- **Personal accounts only** (GitHub `selanavot`, personal Cloudflare). Nothing public until
  explicitly decided.

## Components

| Piece | Where | Notes |
|---|---|---|
| Metadata | Cloudflare D1 (`db/schema.sql`) | papers, FTS5 search, candidate sources, uploads |
| PDFs | Cloudflare R2 bucket `open-cryptology-pdfs` | `pdf/YYYY/NNNN.pdf`; uploads under `quarantine/` |
| Site + API | Cloudflare Worker (`worker/`) | server-rendered HTML, JSON API, `llms.txt` |
| Pipeline | `pipeline/` (Python, stdlib) | OAI harvest → D1; source discovery; sample ingest |
| Updates | Cron Trigger (later) | daily OAI `from=` harvest + ingest queue |

## Routes (Worker)

- `/` — purpose, search box, stats, recent papers, license guidance, issues link
- `/search?q=` — FTS over title/authors/abstract
- `/YYYY/NNNN` — paper page (ePrint-like layout, orange theme): title, authors, abstract,
  metadata (category, license, dates), PDF link if mirrored else upload form, link to the
  original ePrint page, BibTeX
- `/YYYY/NNNN.pdf` — PDF from R2 with license headers (`Link: <license>; rel="license"`)
- `/YYYY/NNNN/upload` (POST) — upload into quarantine
- `/api/papers/YYYY/NNNN` — JSON metadata; `/api/search?q=` — JSON search
- `/llms.txt`, `/robots.txt`, `/about` (license guidance for humans and agents)

## License handling

Every live ePrint paper lists a CC license in its metadata (~93% CC BY 4.0, plus CC0, BY-SA,
BY-NC, BY-NC-SA, BY-NC-ND). Pages and API responses always show the license, the authors and a
link to the original. Papers posted before 2022 had their license assigned retroactively by
IACR; their pages say so. ND-licensed papers are served verbatim only (no derived text).
Withdrawn papers are tombstoned.
