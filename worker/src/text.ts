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
- PDF (when mirrored): ${origin}/YYYY/NNN.pdf   (check "pdf" in the JSON first; if we don't have it,
  you get a 404 with a plain-text explanation, or JSON if you send Accept: application/json)
  This is the latest copy we hold. Other stored copies: ${origin}/YYYY/NNN/versions/YYYYMMDDThhmmssZ.pdf
  (listed in the JSON "versions"; the stamp is when the public copy was captured).
- Search (JSON): ${origin}/api/search?q=QUERY&page=1&sort=relevance|new
  Supports "phrases", prefix*, and author:/title:/abstract: filters. An ID query like "2024/123" is
  reported in "id_match".
- Search (HTML): ${origin}/search?q=QUERY
- Papers we have no PDF for yet (JSON): ${origin}/api/missing?page=1&year=YYYY   (50 per page, newest
  first; fields: id, title, year, url, original_url, upload_url; plus total, total_pages, next).
  HTML: ${origin}/missing. Uploads are made by people through the form on each paper page.
- Search result fields: id, title, authors, category, license, submitted, withdrawn, withdrawn_on,
  has_pdf, pdf_url (null if we have no PDF), upload_url (where a person can upload a missing PDF),
  snippet, url, api_url.
- Home (purpose, license guidance, contact form): ${origin}/

## If we don't have a PDF yet

Some papers (mostly very recent ones) have no PDF here yet. The original is on ePrint at
${env.ORIGIN_BASE}/YYYY/NNN, but ePrint's PDF downloads sit behind a bot check, so ask your user to
download it there. Then either you or they can upload it:

- Agents: POST the PDF to ${origin}/api/upload/YYYY/NNN
    curl -X POST --data-binary @paper.pdf -H "Content-Type: application/pdf" ${origin}/api/upload/2026/123
  Responses (JSON):
  - 201 {"status":"live", "pdf_url": ...}: the file matched the paper (title and an author's name on
    its first pages) and is live now.
  - 202 {"status":"queued_for_review", "id", "check", "message"}: received and stored, but we couldn't
    confirm automatically that it is this paper, so a person will review it. This is not a failure:
    do not upload it again (the same file again also gets 202, and isn't stored twice).
  - 200 {"status":"already_have_it"}: we already have this exact file.
  - 200 {"status":"confirmed_current"}: the paper was marked "maybe_stale" and this is exactly the
    copy we have, so it is now marked as the latest version.
  - 409 {"error":"older_version"}: we already hold this file as an earlier version.
  - 409 if we already have an up-to-date PDF; 413 over 30 MB;
    415/422 if it isn't a readable PDF or contains scripts or attachments; 429 if rate-limited.
  No account or CAPTCHA needed.
- People: the upload form at ${origin}/YYYY/NNN#upload (the "upload_url" in the JSON).

Uploads are anonymous. A matching file goes live right away for everyone, including other agents;
anything else is checked by a person first.
- Original ePrint page for any paper: ${env.ORIGIN_BASE}/YYYY/NNN

## JSON paper fields

id, title, authors[], affiliations[] | null, abstract (may contain TeX: $...$), category,
license {code, url, label, attribution, retroactive, redistribute_verbatim_only, non_commercial},
dates {submitted, updated, withdrawn}, original_url,
pdf {url, sha256, size, source, source_date, maybe_stale, withdrawn} | null,
versions[] {url, captured_at, label, source, source_url, size, sha256, is_default_pdf} (newest first),
other_sources[], withdrawn, withdrawn_on, bibtex.

Versions are the distinct PDF files we found in public copies (Wayback Machine, community GitHub
mirror, verified uploads), labelled by capture date ("copy captured 2024-03-02"). They are not
ePrint's own revision numbers; ePrint's own version list is on the original page.

Withdrawn papers: like ePrint, the mirror keeps the full abstract page (HTTP 200) with
"withdrawn": true and "withdrawn_on" (YYYY-MM-DD). If we hold a copy, the last available PDF is
still served (HTTP 200, header X-Withdrawn: 1); please respect the authors' withdrawal: prefer
not to rely on or redistribute a withdrawn paper without saying it was withdrawn. If we hold no copy,
/YYYY/NNN.pdf answers 410. ePrint keeps a withdrawn paper's earlier versions at
${env.ORIGIN_BASE}/archive/versions/YYYY/NNN/: have your user download the latest one and upload it
like any other paper.

## License obligations (apply to you too)

Each paper is under the Creative Commons license its authors chose; it is in the JSON "license"
field and in the PDF's \`Link: <...>; rel="license"\` and \`X-License\` headers.
- Always attribute: name the authors and link the original ePrint entry (use license.attribution).
- CC BY / CC BY-SA / CC0: reuse is allowed with attribution; SA adaptations must keep the license.
- NC (BY-NC, BY-NC-SA, BY-NC-ND): no commercial use.
- ND (BY-NC-ND): redistribute verbatim only; do not distribute modified or derived versions.
- Papers posted before 2022 had their license assigned retroactively by the IACR.
- When citing, cite the ePrint entry (see "bibtex"), not this mirror.
- "maybe_stale": ePrint changed the paper after our copy was captured, so the mirrored PDF may be
  an older revision. Uploads of the latest version are welcome for these papers, the same way as
  for missing ones.
- PDF responses carry X-Captured-At (when the copy was captured) and, for withdrawn papers, X-Withdrawn: 1.

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
