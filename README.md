# Open Cryptology

Open Cryptology starts as an unofficial, non-commercial mirror of the
[Cryptology ePrint Archive](https://eprint.iacr.org), built so papers are easy to find and fetch,
for people and for AI assistants. The longer-term goal is a shared, up-to-date place for each
paper: discussion, links between papers and the protocols they build on, and known attacks.

> **Not affiliated with or endorsed by the IACR.** The original archive is
> <https://eprint.iacr.org>; cite papers there, not here.

## Why

ePrint is where much of cryptography research first appears. Its abstract pages are open, but its
PDFs sit behind a bot challenge that also blocks AI assistants fetching a single paper on a user's
behalf, which [IACR's own AI policy](https://iacr.org/policy/AIPolicy.html) explicitly allows.
Existing workarounds (the Wayback Machine, old community mirrors) are patchy and go stale.

This mirror serves every paper as a simple page plus a direct PDF link, with the same URL scheme as
ePrint (`/2024/123`, `/2024/123.pdf`) and a small JSON API.

## How it works

- **Metadata** comes from ePrint's public [OAI-PMH feed](https://eprint.iacr.org/oai), which is
  CC0, harvested incrementally and politely.
- **PDFs** come from existing public copies (the Wayback Machine, community mirrors,
  open-access copies) and from uploads that are verified against the paper's metadata before they
  appear. **We never scrape PDFs from eprint.iacr.org.**
- **Licenses:** every paper keeps the Creative Commons license its authors chose on ePrint
  (mostly CC BY 4.0). Each page and API response states the license, the authors and a link to
  the original.
- **Stack:** a Cloudflare Worker (TypeScript) for the site and API, D1 (SQLite) for metadata and
  search, and R2 for PDFs. The repository holds code only, no papers or metadata.

## Using it

| What | URL |
|---|---|
| Paper page | `/YYYY/NNNN` |
| PDF | `/YYYY/NNNN.pdf` |
| Paper metadata (JSON) | `/api/papers/YYYY/NNNN` |
| Search (JSON) | `/api/search?q=...` |
| Guide for AI agents | `/llms.txt` |

Please fetch individual papers as you need them rather than crawling everything.

## Licenses and attribution

Papers are licensed by their authors, not by this project.

- **CC BY / CC BY-SA:** credit the authors and link the original ePrint entry. Share adaptations
  of BY-SA papers under the same license.
- **CC BY-NC (-SA/-ND):** no commercial use.
- **CC BY-NC-ND:** share only unmodified copies.
- **CC0:** no conditions, but please still cite.

For papers posted before 2022, the license was assigned retroactively by IACR; those pages say so.

## Takedowns and contact

If you're an author and want a paper removed or corrected, use the contact form on the site or
open an issue. Requests are handled promptly.

## Development

```bash
cd worker && npm install
npm run db:init          # create the local D1 schema
npx wrangler dev         # http://localhost:8787
```

Data pipeline (metadata harvest, source discovery, small sample ingest): see
[`pipeline/README.md`](pipeline/README.md). Design notes: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## License

Code: MIT, see [`LICENSE`](LICENSE). Paper content: each paper's own license, as stated on its page.
