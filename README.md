<p align="center">
  <img src="worker/public/static/logo.svg" alt="Open Cryptology logo" width="112" height="112">
</p>

<h1 align="center">Open Cryptology</h1>

<p align="center">
  An open home for cryptography papers, for people and for the AI agents that help them.<br>
  <a href="https://opencryptology.org">opencryptology.org</a>
</p>

> **Not affiliated with or endorsed by the IACR.** The original archive is
> <https://eprint.iacr.org>; cite papers there, not here.

## Vision

AI agents have become genuinely useful for research, from literature review to smarter search,
but only if they can read prior work. Open Cryptology starts as an unofficial, non-commercial
mirror of the [Cryptology ePrint Archive](https://eprint.iacr.org) that makes every paper easy to
find and fetch, for humans and agents alike.

The longer-term goal is a **one-stop place for everything known about each paper**, kept up to
date as cryptography moves on:

- discussion of the paper,
- links between papers and the protocols they build on,
- known attacks on each construction.

## Why

ePrint is where much of cryptography research first appears. Its abstract pages are open, but its
PDFs sit behind a bot challenge that also blocks AI assistants fetching a single paper on a user's
behalf, which [IACR's own AI policy](https://iacr.org/policy/AIPolicy.html) explicitly allows.
Existing workarounds (the Wayback Machine, old community mirrors) are patchy and go stale.

Open Cryptology serves every paper as a simple page plus a direct PDF link, with the same URL
scheme as ePrint (`/2024/123`, `/2024/123.pdf`) and a small JSON API. New papers appear within days
of being accepted on ePrint. We don't take submissions: [submit to ePrint](https://eprint.iacr.org/submit) as usual.

## Using it

| What | URL |
|---|---|
| Paper page | `/YYYY/NNNN` |
| PDF | `/YYYY/NNNN.pdf` |
| Paper metadata (JSON) | `/api/papers/YYYY/NNNN` |
| Search (JSON) | `/api/search?q=...` |
| Guide for AI agents | `/llms.txt` |

Please fetch individual papers as you need them rather than crawling everything. If a PDF is
missing, you can download it from ePrint and upload it on the paper's page; uploads are checked
against the paper's metadata before they appear.

## How it works

- **Metadata** comes from ePrint's public [OAI-PMH feed](https://eprint.iacr.org/oai) (CC0),
  harvested incrementally and politely (every 4 hours at most).
- **PDFs** come from existing public copies (community mirrors, the Wayback Machine, open-access
  copies) and from verified reader uploads. **We never fetch PDFs from eprint.iacr.org.**
- **Stack:** a Cloudflare Worker (TypeScript) for the site and API, D1 (SQLite) for metadata and
  search, and R2 for PDFs. This repository holds code only: no papers, no metadata dumps.

Design notes: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/INGESTION.md`](docs/INGESTION.md).

## Licenses and attribution

Papers are licensed by their authors, not by this project. Every paper keeps the Creative Commons
license its authors chose on ePrint (mostly CC BY 4.0), and every page and API response states the
license, the authors and a link to the original.

- **CC BY / CC BY-SA:** credit the authors and link the original ePrint entry. Share adaptations
  of BY-SA papers under the same license.
- **CC BY-NC (-SA/-ND):** no commercial use.
- **CC BY-NC-ND:** share only unmodified copies.
- **CC0:** no conditions, but please still cite.

For papers posted before 2022, the license was assigned retroactively by IACR; those pages say so.

## Contributing

**Pull requests are welcome**, from typo fixes to whole features. The vision above (discussion,
links between papers, known attacks) has plenty of room for help. If you'd like to get more
involved, or want to talk an idea through before building it, get in touch: open an
[issue](https://github.com/selanavot/open-cryptology/issues), use the contact form on
[opencryptology.org](https://opencryptology.org/#contact), or reach out to
[@selanavot](https://github.com/selanavot) directly.

A note on how this project is built: it is **heavily AI-agent assisted**. You're welcome to work
the same way. Just remember to tell your agents to make no mistakes. 🙂

A few house rules (also in [`CLAUDE.md`](CLAUDE.md), which your agent will likely read anyway):

- Never fetch PDFs from eprint.iacr.org or work around its bot challenge.
- Git holds code only: no PDFs, metadata dumps or secrets.
- Keep the simplified-ePrint look (see `worker/public/static/style.css`).

### Development

```bash
cd worker && npm install
npm run db:init          # create the local D1 schema
npx wrangler dev         # http://localhost:8787
```

Data pipeline (metadata harvest, source discovery, small sample ingest): see
[`pipeline/README.md`](pipeline/README.md).

## Takedowns and contact

If you're an author and want a paper removed or corrected, use the
[contact form](https://opencryptology.org/#contact) on the site or open an issue. Requests are
handled promptly.

## License

Code: [MIT](LICENSE). Paper content: each paper's own license, as stated on its page.
