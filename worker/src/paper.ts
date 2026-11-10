import { canonicalId, getPaper, getSources, parseAuthors, type Env, type Paper, type Source } from "./db";
import { html, safeUrl, type Html } from "./html";
import { categoryBadge, hasTex, icons, messagePage, page } from "./layout";
import { bibtex, licenseInfo, originalUrl, type LicenseInfo } from "./license";
import { lookupPaper } from "./oai";
import { day, fmtInt, json } from "./pages";

export const MAX_UPLOAD = 20 * 1024 * 1024;

const SOURCE_LABELS: Record<string, string> = {
  "github-mirror": "community GitHub mirror",
  wayback: "Internet Archive Wayback Machine",
  arxiv: "arXiv",
  oa: "open-access copy",
  upload: "verified upload",
  other: "other public copy",
};
const sourceLabel = (k: string | null) => (k ? SOURCE_LABELS[k] ?? k : "unknown source");

function fmtSize(n: number | null): string {
  if (!n) return "";
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

// ---------------------------------------------------------------------------- paper page

export async function paperPage(
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  year: number,
  num: number,
): Promise<Response> {
  const id = canonicalId(year, num);
  const orig = originalUrl(env.ORIGIN_BASE, id);
  const look = await lookupPaper(env, ctx, year, num);
  if (look.kind === "missing") return paperMissing(env, id, orig, !!look.upstreamError);
  const p = look.paper;
  if (p.withdrawn) return tombstone(env, p, orig);

  const sources = await getSources(env, id);
  const lic = licenseInfo(p, env.ORIGIN_BASE);
  const authors = parseAuthors(p.authors);
  const pdfHref = p.pdf_key ? `/${id}.pdf` : null;

  const body = html`<div class="paper-row">
  <div class="paper-main">
    <h4>Paper ${id}</h4>
    <h3 class="paper-title tex"><a href="${pdfHref ?? orig}">${p.title}</a></h3>
    ${authors.map((a) => html`<div class="author"><span class="authorName">${a}</span></div>`)}
    ${p.pdf_maybe_stale ? staleNote(p) : ""}
    <h5 class="mt-3">Abstract</h5>
    <p class="paper-abstract tex">${p.abstract || "No abstract available."}</p>
  </div>
  <div id="metadata" class="paper-meta">
    <h5>Metadata</h5>
    <dl>
      <dt id="pdf-status">Available format(s)</dt>
      <dd>${pdfHref
        ? html`<a class="btn btn-sm btn-outline-dark" href="${pdfHref}">${icons.pdf}PDF</a>
          <div class="small text-muted mt-1">${fmtSize(p.pdf_size)}${p.pdf_size ? " · " : ""}from ${sourceLabel(p.pdf_source)}${p.pdf_source_date ? `, captured ${day(p.pdf_source_date)}` : ""}</div>`
        : html`<span class="badge bg-light">Not mirrored yet</span>`}
        ${otherCopies(sources, p)}
        ${!p.pdf_key && uploadForm(p)}
      </dd>
      ${p.category && html`<dt>Category</dt><dd><a rel="nofollow" href="/search?${new URLSearchParams({ q: p.category }).toString()}">${categoryBadge(p.category)}</a></dd>`}
      <dt>License</dt>
      <dd>${licenseBadge(lic)}
        ${lic.nd && html`<div class="small mt-1"><strong>NoDerivatives:</strong> redistribute verbatim only — no modified or derived versions.</div>`}
        ${lic.retroactive && html`<div class="small text-muted mt-1">Assigned retroactively by the IACR for papers posted before 2022.</div>`}
      </dd>
      <dt>History</dt>
      ${p.updated && p.updated !== p.submitted && html`<dd><time datetime="${p.updated}">${day(p.updated)}</time>: last updated on ePrint</dd>`}
      ${p.submitted && html`<dd><time datetime="${p.submitted}">${day(p.submitted)}</time>: submitted</dd>`}
      ${look.fresh && html`<dd class="text-muted small">metadata fetched just now from ePrint</dd>`}
      <dt>Original</dt>
      <dd><a href="${orig}" rel="noopener">${orig.replace(/^https?:\/\//, "")}</a></dd>
      <dt>Short URL</dt>
      <dd><a href="https://ia.cr/${id}" rel="noopener">https://ia.cr/${id}</a></dd>
      <dt>Machine-readable</dt>
      <dd><a href="/api/papers/${id}">JSON</a></dd>
    </dl>
  </div>
</div>

${licenseBlock(lic, orig)}

<p class="mt-4 mb-2"><strong>BibTeX</strong>
  <button type="button" class="ms-2 btn btn-sm btn-outline-dark" data-copy="bibtex" aria-label="Copy BibTeX to clipboard">${icons.copy}<span>Copy to clipboard</span></button></p>
<pre id="bibtex">${bibtex(p, env.ORIGIN_BASE)}</pre>
<p class="small text-muted mb-1">Please cite the original ePrint entry (as above), not this mirror.</p>
<p class="small mb-0"><a href="/contact?paper=${p.id}">Report a problem with this paper</a></p>`;


  return page(env, {
    title: `${id}: ${p.title}`,
    description: (p.abstract ?? "").replace(/\s+/g, " ").slice(0, 200),
    body,
    katex: hasTex(p.title, p.abstract),
    original: orig,
    originalLabel: `View paper ${id} on the original ePrint`,
    canonical: orig, // search engines should prefer the original
    cache: "public, max-age=600",
    headers: lic.url ? { link: `<${lic.url}>; rel="license"` } : undefined,
  });
}

function staleNote(p: Paper): Html {
  return html`<div class="alert alert-warning small mt-3">The mirrored PDF may be an older revision: it comes from the
  ${sourceLabel(p.pdf_source)}${p.pdf_source_date ? `, captured ${day(p.pdf_source_date)}` : ""}, and the
  paper was updated on ePrint ${p.updated ? `on ${day(p.updated)}` : "since"}. Check the original for the latest version.</div>`;
}

function licenseBadge(lic: LicenseInfo): Html {
  if (!lic.code) return html`<span class="text-muted">Unknown — see the original page</span>`;
  const u = safeUrl(lic.url);
  return html`<span class="cc">${lic.code}</span><br>
  <small>${u ? html`<a href="${u}" rel="license noopener">${lic.label}</a>` : lic.label}</small>`;
}

function licenseBlock(lic: LicenseInfo, orig: string): Html {
  const u = safeUrl(lic.url);
  return html`<p class="mt-4 mb-2"><strong>Attribution</strong>
  <button type="button" class="ms-2 btn btn-sm btn-outline-dark" data-copy="attribution" aria-label="Copy attribution to clipboard">${icons.copy}<span>Copy to clipboard</span></button></p>
<p id="attribution" class="attribution">${lic.attribution}</p>
${lic.code &&
html`<p class="small mb-0">You may reuse this paper under the terms of the
${u ? html`<a href="${u}" rel="license noopener">license deed</a>` : "license"}:
credit the authors and link the <a href="${orig}">original</a>${lic.nc ? "; no commercial use" : ""}${lic.sa ? "; share adaptations under the same license" : ""}${lic.nd ? "; redistribute verbatim only" : ""}.</p>`}`;
}

function otherCopies(sources: Source[], p: Paper): Html | "" {
  const items = sources
    .map((s) => ({ s, u: safeUrl(s.url) }))
    .filter((x) => x.u);
  if (!items.length) return "";
  return html`<div class="other-copies small"><span class="text-muted">${p.pdf_key ? "Other copies" : "Copies elsewhere"}:</span>
  <ul>${items.map(
    ({ s, u }) => html`<li><a href="${u}" rel="noopener nofollow">${sourceLabel(s.kind)}</a>${
      s.captured_at ? html` <span class="text-muted">(${day(s.captured_at)})</span>` : ""
    }</li>`,
  )}</ul></div>`;
}

function uploadForm(p: Paper): Html {
  return html`<form id="upload" action="/${p.id}/upload" method="post" enctype="multipart/form-data" class="upload-form">
  <p class="small mb-2">Have a copy (e.g. downloaded from ePrint as a reader)? Upload it anonymously.
  We never download PDFs from ePrint ourselves; uploads are checked against the paper before they appear.</p>
  <label for="file" class="form-label small">PDF file (max ${fmtInt(MAX_UPLOAD / 1024 / 1024)} MB)</label>
  <input type="file" id="file" name="file" class="form-control form-control-sm" accept="application/pdf,.pdf" required>
  <div class="hp" aria-hidden="true">
    <label for="website">Leave this field empty</label>
    <input type="text" id="website" name="website" tabindex="-1" autocomplete="off">
  </div>
  <button type="submit" class="btn btn-sm btn-outline-dark mt-2">Upload for verification</button>
</form>`;
}

function paperMissing(env: Env, id: string, orig: string, upstreamError: boolean): Response {
  return messagePage(
    env,
    404,
    `Paper ${id} not found`,
    html`<p>${upstreamError
      ? "This paper isn’t in the mirror yet, and we couldn’t reach ePrint to check just now."
      : "This paper isn’t in the mirror. If it was posted very recently it may appear shortly."}</p>
    <p><a class="btn btn-outline-dark" href="${orig}" rel="noopener">Try it on the original ePrint ↗</a></p>
    <p>Or <a href="/search">search the mirror</a>.</p>`,
    { original: orig, originalLabel: `Paper ${id} on the original ePrint`, cache: "public, max-age=60" },
  );
}

function tombstone(env: Env, p: Paper, orig: string): Response {
  return messagePage(
    env,
    410,
    p.title ? `Withdrawn: ${p.title}` : `Paper ${p.id} has been withdrawn`,
    html`${p.title && html`<p class="text-muted mb-2">Paper ${p.id}</p>`}
    <p>This paper has been withdrawn from the Cryptology ePrint Archive${p.updated ? ` (as of ${day(p.updated)})` : ""}.
    The mirror keeps only this tombstone; no PDF or abstract is served.</p>
    <p><a href="${orig}" rel="noopener">See the original entry on ePrint ↗</a></p>`,
    { original: orig, originalLabel: `Paper ${p.id} on the original ePrint`, cache: "public, max-age=3600", noindex: true },
  );
}

// ---------------------------------------------------------------------------- PDF

export async function servePdf(
  env: Env,
  req: Request,
  year: number,
  num: number,
): Promise<Response> {
  const id = canonicalId(year, num);
  const orig = originalUrl(env.ORIGIN_BASE, id);
  const p = await getPaper(env, id);
  const missing = (status: number, msg: string) =>
    messagePage(
      env,
      status,
      `PDF for ${id} not available`,
      html`<p>${msg}</p><p><a class="btn btn-outline-dark" href="/${id}">Back to paper ${id}</a>
      <a class="btn btn-outline-dark" href="${orig}" rel="noopener">Original on ePrint ↗</a></p>`,
      { original: orig },
    );
  if (!p) return missing(404, "This paper isn’t in the mirror.");
  if (p.withdrawn) return missing(410, "This paper has been withdrawn.");
  if (!p.pdf_key) return missing(404, "We don’t have a mirrored copy of this PDF yet.");

  const lic = licenseInfo(p, env.ORIGIN_BASE);
  const etag = p.pdf_sha256 ? `"${p.pdf_sha256}"` : null;
  const headers = new Headers({
    "content-type": "application/pdf",
    "content-disposition": `inline; filename="${id.replace("/", "-")}.pdf"`,
    "cache-control": "public, max-age=86400",
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
  });
  const links = [`<${orig}.pdf>; rel="canonical"`];
  if (lic.url) links.unshift(`<${lic.url}>; rel="license"`);
  headers.set("link", links.join(", "));
  if (lic.code) headers.set("x-license", lic.code);
  if (etag) headers.set("etag", etag);
  if (p.pdf_maybe_stale) headers.set("x-mirror-note", "may-be-older-revision");

  const inm = req.headers.get("if-none-match");
  if (etag && inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers });
  }

  if (req.method === "HEAD") {
    const h = await env.PDFS.head(p.pdf_key);
    if (!h) return missing(404, "The mirrored file is missing from storage.");
    headers.set("content-length", String(h.size));
    if (!etag) headers.set("etag", h.httpEtag);
    return new Response(null, { headers });
  }

  const hasRange = req.headers.has("range");
  const obj = await env.PDFS.get(p.pdf_key, hasRange ? { range: req.headers } : undefined);
  if (!obj) return missing(404, "The mirrored file is missing from storage.");
  if (!etag) headers.set("etag", obj.httpEtag);
  const size = obj.size;
  const r = obj.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (hasRange && r) {
    let start: number, len: number;
    if (r.suffix !== undefined) {
      len = Math.min(r.suffix, size);
      start = size - len;
    } else {
      start = r.offset ?? 0;
      len = r.length ?? size - start;
    }
    headers.set("content-range", `bytes ${start}-${start + len - 1}/${size}`);
    headers.set("content-length", String(len));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(size));
  return new Response(obj.body, { headers });
}

// ---------------------------------------------------------------------------- upload

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function handleUpload(
  env: Env,
  req: Request,
  url: URL,
  year: number,
  num: number,
): Promise<Response> {
  // TODO(auth): require a Cloudflare Turnstile token and a GitHub OAuth login before accepting
  //   uploads; record the GitHub login in uploads.uploader.
  // TODO(rate-limit): per-IP / per-account rate limiting (e.g. Workers Rate Limiting binding).
  const id = canonicalId(year, num);
  const back = html`<p><a class="btn btn-outline-dark" href="/${id}">Back to paper ${id}</a></p>`;
  const fail = (status: number, title: string, msg: string) =>
    messagePage(env, status, title, html`<p>${msg}</p>${back}`, { cache: "no-store" });

  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) return fail(403, "Upload rejected", "Cross-site uploads are not accepted.");

  const p = await getPaper(env, id);
  if (!p) return fail(404, "Paper not found", `Paper ${id} isn’t in the mirror.`);
  if (p.withdrawn) return fail(410, "Paper withdrawn", "Withdrawn papers don’t accept uploads.");

  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_UPLOAD + 64 * 1024) return fail(413, "File too large", "PDFs must be 20 MB or smaller.");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "Upload failed", "We couldn’t read that upload. Please use the form on the paper page.");
  }
  const thanks = (dup: boolean) =>
    messagePage(
      env,
      200,
      "Thank you!",
      html`<p>${dup
        ? "We already received this exact file for this paper; it is waiting for verification."
        : html`We received your PDF for paper <strong>${id}</strong>. It is in quarantine and will be
          verified (that it is a valid PDF and matches this paper’s title and authors) before it appears on the site.`}</p>
      <p class="small muted">Verification may take a while. Nothing else is needed from you.</p>${back}`,
      { cache: "no-store", noindex: true },
    );

  // Honeypot: bots fill every field. Pretend success, store nothing.
  const hp = form.get("website");
  if (typeof hp === "string" && hp.trim() !== "") return thanks(false);

  const file = form.get("file");
  if (!file || typeof file === "string") return fail(400, "No file", "Please choose a PDF file to upload.");
  if (file.size === 0) return fail(400, "Empty file", "That file is empty.");
  if (file.size > MAX_UPLOAD) return fail(413, "File too large", "PDFs must be 20 MB or smaller.");

  const buf = await file.arrayBuffer();
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(5, buf.byteLength)));
  if (head !== "%PDF-") return fail(415, "Not a PDF", "That file doesn’t look like a PDF (it must start with %PDF).");

  const sha = toHex(await crypto.subtle.digest("SHA-256", buf));
  if (p.pdf_sha256 && p.pdf_sha256.toLowerCase() === sha) {
    return messagePage(
      env,
      200,
      "We already have it",
      html`<p>That file is identical to the PDF already mirrored for paper ${id}. Thanks anyway!</p>${back}`,
      { cache: "no-store", noindex: true },
    );
  }
  const dup = await env.DB.prepare(
    "SELECT id FROM uploads WHERE paper_id = ?1 AND sha256 = ?2 AND status = 'pending' LIMIT 1",
  )
    .bind(id, sha)
    .first();
  if (dup) return thanks(true);

  const uploadId = crypto.randomUUID();
  const key = `quarantine/${uploadId}.pdf`;
  await env.PDFS.put(key, buf, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { paper_id: id, sha256: sha, original_name: file.name.slice(0, 200) },
  });
  await env.DB.prepare(
    `INSERT INTO uploads (id, paper_id, r2_key, sha256, size, uploader, created_at, status, checks)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, 'pending', NULL)`,
  )
    .bind(uploadId, id, key, sha, buf.byteLength, new Date().toISOString())
    .run();
  return thanks(false);
}

// ---------------------------------------------------------------------------- API

export async function apiPaper(
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  year: number,
  num: number,
): Promise<Response> {
  const id = canonicalId(year, num);
  const origin = url.origin;
  const orig = originalUrl(env.ORIGIN_BASE, id);
  const look = await lookupPaper(env, ctx, year, num);
  if (look.kind === "missing") {
    return json(
      { error: "not_found", id, original_url: orig, upstream_error: !!look.upstreamError },
      404,
      "public, max-age=60",
    );
  }
  const p = look.paper;
  if (p.withdrawn) {
    return json(
      { id, withdrawn: true, title: p.title || null, original_url: orig, dates: { updated: p.updated } },
      410,
      "public, max-age=3600",
    );
  }
  const lic = licenseInfo(p, env.ORIGIN_BASE);
  const sources = await getSources(env, id);
  return json({
    id,
    url: `${origin}/${id}`,
    original_url: orig,
    title: p.title,
    authors: parseAuthors(p.authors),
    abstract: p.abstract,
    category: p.category,
    license: {
      code: lic.code,
      url: lic.url,
      label: lic.label,
      attribution: lic.attribution,
      retroactive: lic.retroactive,
      redistribute_verbatim_only: lic.nd,
      non_commercial: lic.nc,
    },
    dates: { submitted: p.submitted, updated: p.updated },
    withdrawn: false,
    pdf: p.pdf_key
      ? {
          url: `${origin}/${id}.pdf`,
          sha256: p.pdf_sha256,
          size: p.pdf_size,
          source: p.pdf_source,
          source_date: p.pdf_source_date,
          maybe_stale: !!p.pdf_maybe_stale,
        }
      : null,
    other_sources: sources.map((s) => ({ kind: s.kind, url: s.url, captured_at: s.captured_at, size: s.size })),
    bibtex: bibtex(p, env.ORIGIN_BASE),
  }, 200, "public, max-age=600");
}
