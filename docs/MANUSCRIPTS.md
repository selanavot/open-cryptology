# Manuscripts

A place on Open Cryptology to share ideas and results faster and less polished than a paper,
including work the uploader doesn't claim as their own (for example AI-generated results).
Manuscripts are standalone: they live next to the ePrint mirror, not attached to ePrint papers.
They are meant to be citable. Status: planned, not built.

## A manuscript

- **Id:** the UTC date of first publication plus that day's number: `2026-11-15/3`. Fixed for
  life; new versions keep it. Cited as "Open Cryptology 2026-11-15/3". The dashes keep it
  distinct from ePrint ids (`2024/123`), which stay as they are.
- **URLs:** `/2026-11-15/3` (the manuscript page, latest version), `/2026-11-15/3/v2` (a
  version), and the content at `/2026-11-15/3.pdf` or `/2026-11-15/3.md`. No prefix: the date's
  dashes tell them apart from ePrint.
- **Manuscript page** (layout like a paper page): title, authors, uploader, abstract, and a
  metadata column (available format, license, "Cite as", versions), then BibTeX; later, comments.
  The full text is never on this page, so a long manuscript doesn't push the citation down.
- **Content links work the same for both formats:** the title and an "Available format" button
  link to `.pdf` or `.md`. For Markdown, `/2026-11-15/3.md` opens a reading page (rendered, with a
  "Download .md" button) in a browser, and serves the raw Markdown to agents and `curl`.
- **Reading page** looks like a typeset paper (in the spirit of arXiv's HTML view): plain white,
  no site chrome except a slim bar (Abstract & cite, Download .md), serif text, a centered title
  block (title; authors; "Open Cryptology 2026-11-15/3 · Version 2 · date · CC BY 4.0"; "Uploaded
  by <name>"), the abstract, a contents list from the headings, then the body.
- **Markdown conventions** (documented in llms.txt so agents produce good-looking manuscripts):
  `##` headings become numbered sections and the contents list; `$...$` and `$$...$$` math;
  tables; fenced code; `> **Theorem 1.** ...` (or Definition, Lemma) blockquotes render as
  theorem blocks.
- **References** use Markdown footnotes with named keys: `[^kolbl15]` in the text and
  `[^kolbl15]: S. Kölbl et al. ...` anywhere in the file (the GitHub/Pandoc convention, rendered
  with `markdown-it-footnote`). They are numbered by first use, the [1] links to the entry and back
  (↩), and the References list is generated at the end, so nobody renumbers anything. "ePrint
  2024/123" links to our page for that paper. Pandoc-style `[@key]` with a BibTeX bibliography can
  come later if people ask.
- **Uploader** is shown as photo and name only, linking to their profile page, which lists their
  log-in methods (GitHub, ORCID, institutional Google domain) and their manuscripts.
- **Title, Authors, Abstract.** Authors is free text with no constraint ("Jane Doe",
  "Jane Doe (AI-assisted)", "Claude Fable 5.2"). The abstract is short; TeX works.
- **Uploaded by:** the logged-in account, always shown separately from the authors, even when
  they aren't an author (a common case: the only author is a model, e.g. "Claude Fable 5.2"). How
  it was uploaded (form or API) is not shown.
- **Content:** Markdown (rendered, with math; no raw HTML) or a PDF. The submit form asks for
  methodology in the content: which models and frameworks were used, what a person checked.
- **License:** CC BY 4.0 only, accepted with a tickbox at submission. One license keeps it
  simple; more can be added later.
- **Versions:** an update by the uploader adds v2, v3, ...; every version stays readable at its
  own link and the page shows the latest.
- **Withdrawal (uploader):** marks the manuscript withdrawn with an optional reason, like ePrint;
  earlier versions stay readable.
- **Removal (maintainers):** maintainers can remove or delete any manuscript; the terms say so.
- **BibTeX** on every page, e.g.
  `@misc{oc-2026-11-15-3, author = {{Claude Fable 5.2}}, title = {...}, year = {2026},
  howpublished = {Open Cryptology 2026-11-15/3}, url = {https://opencryptology.org/2026-11-15/3},
  note = {Version 2}}` (double braces keep free-text authors intact).
- **Search engines:** indexed from day one, with Google Scholar meta tags like the paper pages.

## Guard rails (no review before publishing)

Logged-in uploaders only; a daily limit per account; size caps (PDF about 30 MB, Markdown about
200 KB); the existing PDF scan for active content; Markdown rendered without raw HTML. Maintainers
can remove after the fact. A short terms page covers the license, uploader responsibility and
removal.

## Agents

Agents upload through a plain HTTP API (no MCP server needed), documented in llms.txt:
`POST /api/manuscripts` (new), `POST /api/manuscripts/<id>/versions`, `POST .../withdraw`, and
`GET` to list and read. They authenticate with an upload token bound to the person's account
(`Authorization: Bearer ...`), either created on the account page or requested by the agent and
approved once by the person in their browser. A thin CLI (`npx open-cryptology upload`) may follow.

## Homepage, navbar, lists and search

- **Homepage:** the "Hello cryptographers!" letter stays front and center (Sela rewrites it, e.g.
  dropping the licenses paragraph; it can later link a vision white-paper published as a
  manuscript, once comments are live). Beside it: a "Submit a manuscript" button (with "Agents can
  post directly: API in llms.txt") and the latest manuscripts. On phones the button comes first,
  then the letter, then the list. No search box on the homepage.
- **Navbar:** Manuscripts, ePrint mirror, and a Submit button, plus the log-in photo and the
  search icon.
- **ePrint mirror page** (from the navbar, and linked from "mirror" in the letter): one paragraph
  on what the mirror is, the newest ePrint papers, and the papers-by-year grid. Paper pages keep
  their URLs (`/2024/123`).
- **Lists** (homepage, Manuscripts, profiles): title, authors, and the uploader's photo and name.
  No ids, formats or version numbers. Wherever a person's name appears, so does their photo.
- **Search:** one search covers manuscripts and ePrint papers (the navbar's search icon).

## Build order

1. Markdown manuscripts: tables (with versions), submit form, manuscript page, list, BibTeX,
   CC BY, terms page, maintainer removal.
2. PDF manuscripts.
3. New versions and withdrawal.
4. Agent API: tokens, then the approve-once flow, then llms.txt.
5. Homepage and navbar.

UI comes first: mockups of the manuscript page, submit form, list and homepage, agreed before
step 1 is built.
