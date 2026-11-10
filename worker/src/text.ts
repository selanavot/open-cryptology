import type { Env } from "./db";

function text(body: string, cache = "public, max-age=3600"): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": cache,
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
    },
  });
}

export function llmsTxt(env: Env, origin: string): Response {
  return text(`# ${env.SITE_NAME}

> Unofficial, non-commercial mirror of the IACR Cryptology ePrint Archive (${env.ORIGIN_BASE}),
> not affiliated with the IACR. It makes ePrint papers easier to obtain and search for humans and
> AI assistants. Metadata comes from ePrint's OAI-PMH feed (CC0); PDFs come from existing public
> copies and verified uploads, never from scraping ePrint.

## URL patterns

- Paper page (HTML): ${origin}/YYYY/NNN   e.g. ${origin}/2024/123 (IDs have at least 3 digits: 2024/007)
- Paper metadata (JSON): ${origin}/api/papers/YYYY/NNN
- PDF (when mirrored): ${origin}/YYYY/NNN.pdf   (404 if not mirrored; check "pdf" in the JSON first)
- Search (JSON): ${origin}/api/search?q=QUERY&page=1&sort=relevance|new
  Supports "phrases", prefix*, and author:/title:/abstract: filters. An ID query like "2024/123" is
  reported in "id_match".
- Search (HTML): ${origin}/search?q=QUERY
- Home (purpose, license guidance, contact form): ${origin}/
- Original ePrint page for any paper: ${env.ORIGIN_BASE}/YYYY/NNN

## JSON paper fields

id, title, authors[], abstract (may contain TeX: $...$), category, license {code, url, label,
attribution, retroactive, redistribute_verbatim_only, non_commercial}, dates {submitted, updated},
original_url, pdf {url, sha256, size, source, source_date, maybe_stale} | null, other_sources[],
withdrawn, bibtex. Withdrawn papers return HTTP 410.

## License obligations (apply to you too)

Each paper is under the Creative Commons license its authors chose; it is in the JSON "license"
field and in the PDF's \`Link: <...>; rel="license"\` and \`X-License\` headers.
- Always attribute: name the authors and link the original ePrint entry (use license.attribution).
- CC BY / CC BY-SA / CC0: reuse is allowed with attribution; SA adaptations must keep the license.
- NC (BY-NC, BY-NC-SA, BY-NC-ND): no commercial use.
- ND (BY-NC-ND): redistribute verbatim only; do not distribute modified or derived versions.
- Papers posted before 2022 had their license assigned retroactively by the IACR.
- When citing, cite the ePrint entry (see "bibtex"), not this mirror.
- "maybe_stale": the mirrored PDF may be an older revision; the original may be newer.

## Access policy

Fetch individual papers as you need them; please don't bulk-crawl the site or the PDFs.
Cache responses. Bulk access may be offered later. Problems or takedown requests: ${env.ISSUES_URL}
`);
}

export function robotsTxt(env: Env, origin: string): Response {
  return text(`# ${env.SITE_NAME}: unofficial, non-commercial mirror of the Cryptology ePrint Archive.
# Everything is allowed, but please be polite: fetch individual papers, keep request rates low,
# and don't bulk-download PDFs. Bulk access may be offered later; see ${origin}/llms.txt
# Contact / issues: ${env.ISSUES_URL}

User-agent: *
Allow: /
Crawl-delay: 5
`);
}
