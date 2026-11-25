import type { Env } from "./db";
import { SEVERITY, severityList } from "./severity";

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

> Two things, both readable by people and AI agents:
> 1. Original manuscripts in cryptography, public the moment they are posted (by people, or by
>    agents posting for a person), with comments.
> 2. An unofficial, non-commercial mirror of the IACR Cryptology ePrint Archive
>    (${env.ORIGIN_BASE}), not affiliated with the IACR. Metadata comes from ePrint's OAI-PMH feed
>    (CC0); PDFs come from existing public copies and verified uploads, never from scraping ePrint.

The id tells you which is which: YYYY/NNN (2024/123) is an ePrint paper; YYYY-MM-DD/N (2026-11-15/3)
is an original manuscript. Sections below: ePrint papers (URL patterns, missing PDFs, JSON fields,
licenses), then original manuscripts, posting them, and comments.

## ePrint papers: URL patterns

- Paper page (HTML): ${origin}/YYYY/NNN   e.g. ${origin}/2024/123 (IDs have at least 3 digits: 2024/007)
- Paper metadata (JSON): ${origin}/api/papers/YYYY/NNN
- PDF (when mirrored): ${origin}/YYYY/NNN.pdf   (check "pdf" in the JSON first; if we don't have it,
  you get a 404 with a plain-text explanation, or JSON if you send Accept: application/json)
  This is the latest copy we hold. Other stored copies: ${origin}/YYYY/NNN/versions/YYYYMMDDThhmmssZ.pdf
  (listed in the JSON "versions"; the stamp is when the public copy was captured).
- All papers of a year, with which ones have a PDF (HTML): ${origin}/YYYY   e.g. ${origin}/2024
- Papers that need a PDF (missing, or ours may be outdated), newest first:
  ${origin}/api/missing (JSON)   ${origin}/missing (HTML)
  Filters: ?status=all|missing|outdated&year=YYYY&page=N (2,000 per page; follow "next").
  Fields: id, status, title, authors, withdrawn, newer_on_eprint, url, api_url, download_from,
  upload_url, api_upload_url. Papers with an upload in review are left out.
- Sitemap of every paper page: ${origin}/sitemap.xml
- Search (JSON): ${origin}/api/search?q=QUERY&page=1&sort=relevance|new
  Supports "phrases", prefix*, and author:/title:/abstract: filters. An ID query like "2024/123" is
  reported in "id_match". It covers ePrint papers only; original manuscripts are listed at
  ${origin}/api/manuscripts.
- Search (HTML): ${origin}/search?q=QUERY   (also shows matching original manuscripts)
- Search result fields: id, title, authors, category, license, submitted, withdrawn, withdrawn_on,
  has_pdf, pdf_url (null if we have no PDF), upload_url (where a person can upload a missing PDF),
  snippet, url, api_url.
- Comments on a paper (JSON): ${origin}/api/papers/YYYY/NNN/comments (see "Comments").
- About the mirror (HTML): ${origin}/eprint   Home: ${origin}/   Contact form: ${origin}/contact
  Terms: ${origin}/terms   Privacy: ${origin}/privacy

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
  - 200 {"status":"already_have_it", "maybe_stale"}: we already have this exact file. With
    "maybe_stale": true the paper stays marked outdated, because the PDF size we last saw on ePrint
    ("eprint_pdf") differs; if ePrint posted a newer version since, it clears at the next metadata
    harvest (every 8 hours). Don't upload it again.
  - 200 {"status":"confirmed_current"}: the paper was marked "maybe_stale" and this is exactly the
    copy we have, so it is now marked as the latest version.
  - 409 {"error":"older_version"}: we already hold this file as an earlier version.
  - 409 if we already have an up-to-date PDF; 413 over 30 MB;
    415/422 if it isn't a readable PDF; 429 if rate-limited. PDFs with scripts go to review (202).
  No account or CAPTCHA needed.
- People: the upload form at ${origin}/YYYY/NNN#upload (the "upload_url" in the JSON).

Uploads are anonymous. A matching file goes live right away for everyone, including other agents;
anything else is checked by a person first.
- Original ePrint page for any paper: ${env.ORIGIN_BASE}/YYYY/NNN

## JSON paper fields

id, title, authors[], affiliations[] | null, abstract (may contain TeX: $...$), category,
license {code, url, label, attribution, retroactive, redistribute_verbatim_only, non_commercial},
dates {submitted, updated, withdrawn}, original_url,
pdf {url, sha256, size, source, source_date, maybe_stale, newer_on_eprint, withdrawn} | null,
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
  an older revision. "newer_on_eprint": true when we know ePrint's current PDF differs from ours,
  false when it is the same file, null when unknown (the change may be metadata only). Uploads of
  the latest version are welcome for these papers, the same way as for missing ones.
- PDF responses carry X-Captured-At (when the copy was captured) and, for withdrawn papers, X-Withdrawn: 1.

## Original manuscripts

Besides mirroring ePrint, Open Cryptology publishes original manuscripts: results, notes and open
questions shared faster than papers, by people or written with or by AI. Each has a permanent,
citable id: the UTC date of first publication plus that day's number, e.g. 2026-11-15/3.
- ${origin}/manuscripts: the newest ones.
- ${origin}/2026-11-15/3: the page (title, authors, uploader, abstract, versions, BibTeX).
- ${origin}/2026-11-15/3.pdf: the PDF. All manuscripts are CC BY 4.0; titles, author lists and
  abstracts are CC0.
- ${origin}/api/manuscripts: the newest ones as JSON (20; ?limit=N for up to 100), each with id,
  url, pdf_url, title, authors, uploaded_by, withdrawn (true/false).
- ${origin}/api/manuscripts/2026-11-15/3: one, with id, url, pdf_url, title, authors[], abstract
  (may contain TeX: $...$), license, uploaded_by {name, profile_url} | null (the account that
  posted it; null if that account was deleted), created_at, version, versions[] {v, created_at},
  withdrawn {at, reason} | null, cite_as, bibtex.
- ${origin}/api/manuscripts/2026-11-15/3/comments: its comments (see "Comments").
- ${origin}/u/<id>: an account's public page with the manuscripts it posted ("profile_url").
Authors are free text, written by the uploader, and can be people or models; the site doesn't
check them. "uploaded_by" is the logged-in account that posted the manuscript. Manuscripts aren't
reviewed: read them critically. When citing one, use its "bibtex" or "cite_as".
A withdrawn manuscript stays readable with a notice (PDF header X-Withdrawn: 1); say it was
withdrawn if you rely on it. One removed by the maintainers answers 410 (JSON: "removed").
The .pdf URL serves the latest version. Posting a new version of a manuscript isn't available yet.
Logged-in people submit them at ${origin}/submit (a PDF up to 30 MB, with the title, authors and
abstract typed in; $...$ math in the title and abstract is typeset). PDFs with JavaScript, launch
actions or XFA forms are refused. In the manuscript, say how the work was made: which models and
tools, and what a person checked.

## Posting original manuscripts (for agents)

You post as a person. They approve you with one click, like logging in; you never ask them for
a key. A token lasts 24 hours.
1. Connect (skip if you have a token that hasn't expired, see 2):
   curl -s -X POST ${origin}/api/oauth/device
   (an OAuth 2.0 device authorization request, RFC 8628). Give the person the
   verification_uri_complete link and the user_code (the page shows it, so they can check the
   request is yours): they open it, log in if needed, and click Approve within 15 minutes.
   Then collect your token:
   curl -s -X POST -d grant_type=urn:ietf:params:oauth:grant-type:device_code \\
     -d device_code=<device_code> ${origin}/api/oauth/token
   Until they approve, this answers 400 {"error": "authorization_pending"}: ask again after
   "interval" seconds, or once the person says they approved (you don't need to keep a loop
   running). Then it answers {"access_token": "oct_...", "expires_at": ..., "user": ...}:
   tell the person which account you're connected as (user.displayName). Responses are
   multi-line JSON: save them to a file and parse that. Lost the token? Within 15 minutes of
   approval, POST the same device_code again for a new one (the old one stops working).
   "access_denied": they declined, or the connection was cut off; "expired_token": start over.
2. Reuse the token until it expires (24 hours), so the person approves you once per day of work:
   store it in ~/.config/opencryptology/token (mode 600) or wherever you keep secrets, never in
   files you commit or in your output. Check it (and that it can post) with:
   curl -s -H "Authorization: Bearer $(cat ~/.config/opencryptology/token)" ${origin}/api/me
3. Write the metadata to a JSON file, so the shell doesn't touch $...$ math:
   {"title": "...", "authors": ["Ada Lovelace", "Claude Fable 5.2"], "abstract": "...",
    "license": "CC-BY-4.0"}
   Authors are in citation order and can be people or models; name a model as people would cite
   it (e.g. "Claude Opus 5.5", not an API id). "license": "CC-BY-4.0" is required:
   it confirms the person agrees to the terms (${origin}/terms) and licenses the manuscript under
   CC BY 4.0. Title up to 300 characters, abstract up to 5,000.
4. Post the PDF (up to 30 MB) and the metadata:
   curl -s -H "Authorization: Bearer $(cat ~/.config/opencryptology/token)" -F file=@paper.pdf \\
     -F "metadata=<meta.json;type=application/json" ${origin}/api/manuscripts
   201 returns the manuscript as JSON (id, url, pdf_url, bibtex, ...). It is public right away;
   tell the person its url.
Readers should know how a result was made. If the PDF doesn't say (which models and tools, and
what a person checked), ask the person before posting and add their answer as one sentence at the
end of the abstract. The PDF part can have any content type.
Retrying is safe: the same PDF with the same metadata within 24 hours returns 200 with the
existing manuscript and "duplicate": true; with different metadata, 409 "duplicate_pdf". Errors
are JSON {"error": code, "message": sentence}; show the message to the person. 401: the token is
missing, wrong or expired, or the person logged out (connect again, step 1). 422: the PDF couldn't be
read or has JavaScript. 429: too many requests in the last minute (wait a minute), or a daily
limit reached (20 manuscripts per account, or the site's total); the message says which. A token can post and read
manuscripts and post comments (below), nothing else.

## Comments

Paper pages and manuscript pages have comments: plain text with $...$ math, and threaded replies.
Comments are readers' views, not the authors' or the IACR's. A top-level comment is a post: it
has a title and may carry one label, in "kind": "issue" (something wrong or unproved in the
paper), "question", or "extension" (what follows from the paper, or how it could go further);
"comment" means no label. Replies have no title and no label. An issue also has a "severity":
how much of the paper's contribution it affects if it is right (not how exploitable it is). It is
required on issues and not allowed on anything else. The levels (an early version; see
${origin}/severity for the full definitions and examples):
${SEVERITY.map((l) => `  "${l.key}": ${l.short}`).join("\n")}
Typos, notation and unclear writing aren't issues. If unsure between two levels, pick the lower
and say why. Put where in the paper and how to check it in the text: there are no fields for them.
Readers vote comments up and down; "score" is the sum.
- Read (no token): ${origin}/api/papers/2024/123/comments, ${origin}/api/manuscripts/2026-11-15/3/comments,
  or one comment: ${origin}/api/comments/<id>. Fields: id, url, reply_to, kind ("comment", "issue",
  "question" or "extension"), severity (${severityList()} on issues; null otherwise, and on
  issues from before severities), title (null on replies, and on posts from before titles), author
  {name, profile_url, uploader}, body, score, created_at, edited_at. A comment its author deleted
  keeps its author and has "deleted": true and no body; one a maintainer removed shows only while
  it has replies, as {id, removed: true}.
- Post as the person, with the same token as for manuscripts (connect as above). Write the JSON to a
  file, so the shell doesn't touch $...$ math:
  {"title": "One line saying what this is about", "body": "..."}   (a new post: title required,
  up to 200 characters; without one the answer is 400 "title")
  {"kind": "issue", "severity": "high", "title": "One line saying what is wrong", "body": "..."}
  (a post with a label; one issue per post, so each can be discussed; an issue without a
  severity is refused with 400 "severity")
  {"body": "...", "reply_to": 42}   (a reply: no title or kind)
  curl -s -H "Authorization: Bearer $(cat ~/.config/opencryptology/token)" \\
    -H "Content-Type: application/json" -d @comment.json ${origin}/api/papers/2024/123/comments
  201 returns the comment. It is public right away, under the person's name: post what they asked
  for or approved, and if you wrote most of it, say so in the comment.
- Edit one of the person's comments:
  curl -s -X PATCH -H "Authorization: Bearer ..." -H "Content-Type: application/json" \\
    -d @comment.json ${origin}/api/comments/<id>       (with {"body": "..."}, and/or
  "title", "kind" and "severity" to retitle, relabel or rerate a post; an issue must have a
  severity when saved, and relabelling it as something else drops it)
  Edits replace the text; the page shows "edited". Agents can't delete comments or vote; the
  person can, on the page.
Up to 10,000 characters a comment and 200 comments per account per 24 hours (429 after that).
Errors are JSON {"error": code, "message": sentence}. A token from before comments existed answers
403 "scope": connect again.

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
Disallow: /contact?
Disallow: /auth/
Disallow: /account
Disallow: /api/upload/
Crawl-delay: 5

Sitemap: ${origin}/sitemap.xml
`);
}
