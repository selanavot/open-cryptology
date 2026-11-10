import { ipHash, overLimit, scanPdf } from "./uploadguard";
import { verifyPdf } from "./verify";
import { turnstileOk, turnstileWidget } from "./turnstile";
import { canonicalId, getPaper, getSources, parseAuthors, type Env, type Paper } from "./db";
import { html, safeUrl, type Html } from "./html";
import { categoryBadge, hasTex, icons, messagePage, page } from "./layout";
import { bibtex, licenseInfo, originalUrl, type LicenseInfo } from "./license";
import { lookupPaper } from "./oai";
import { day, json } from "./pages";

export const MAX_UPLOAD = 20 * 1024 * 1024;

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

  const lic = licenseInfo(p, env.ORIGIN_BASE);
  const authors = parseAuthors(p.authors);
  const pdfHref = p.pdf_key ? `/${id}.pdf` : null;

  const body = html`<div class="paper-row">
  <div class="paper-main">
    <h4>Paper ${id}</h4>
    <h3 class="paper-title tex"><a href="${pdfHref ?? orig}">${p.title}</a></h3>
    ${authors.map((a) => html`<div class="author"><span class="authorName">${a}</span></div>`)}
    ${!pdfHref && uploadForm(env, p, orig)}
    <h5 class="mt-3">Abstract</h5>
    <p class="paper-abstract tex">${p.abstract || "No abstract available."}</p>
  </div>
  <div id="metadata" class="paper-meta">
    <h5>Metadata</h5>
    <dl>
      <dt id="pdf-status">Available format(s)</dt>
      <dd>${pdfHref
        ? html`<a class="btn btn-sm btn-outline-dark" href="${pdfHref}">${icons.pdf}PDF</a>
          ${p.pdf_maybe_stale ? html`<div class="small text-muted mt-1">May be an older revision</div>` : ""}`
        : html`<span class="text-muted">No PDF here yet.</span> <a href="#upload">Upload it</a>`}
      </dd>
      ${p.category && html`<dt>Category</dt><dd><a rel="nofollow" href="/search?${new URLSearchParams({ q: p.category }).toString()}">${categoryBadge(p.category)}</a></dd>`}
      <dt>License</dt>
      <dd>${licenseBadge(lic)}</dd>
      <dt>History</dt>
      ${p.updated && p.updated !== p.submitted && html`<dd><time datetime="${p.updated}">${day(p.updated)}</time>: last updated</dd>`}
      ${p.submitted && html`<dd><time datetime="${p.submitted}">${day(p.submitted)}</time>: submitted</dd>`}
      <dt>Original</dt>
      <dd><a href="${orig}" rel="noopener">View on ePrint ↗</a></dd>
    </dl>
  </div>
</div>

<p class="mt-4 mb-2"><strong>BibTeX</strong>
  <button type="button" class="ms-2 btn btn-sm btn-outline-dark" data-copy="bibtex" aria-label="Copy BibTeX to clipboard">${icons.copy}<span>Copy to clipboard</span></button></p>
<pre id="bibtex">${bibtex(p, env.ORIGIN_BASE)}</pre>
<p class="small mb-0"><a href="/?paper=${p.id}#contact">Report a problem with this paper</a></p>`;

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


function licenseBadge(lic: LicenseInfo): Html {
  if (!lic.code) return html`<span class="text-muted">See the original page</span>`;
  const u = safeUrl(lic.url);
  const title = lic.retroactive ? `${lic.label} (assigned retroactively by the IACR)` : lic.label;
  return u ? html`<a class="cc" href="${u}" rel="license noopener" title="${title}">${lic.code}</a>` : html`<span class="cc" title="${title}">${lic.code}</span>`;
}



function uploadForm(env: Env, p: Paper, orig: string): Html {
  return html`<form id="upload" action="/${p.id}/upload" method="post" enctype="multipart/form-data" class="upload-form upload-cta">
  <p class="upload-cta-head"><strong>We don’t have this PDF yet.</strong></p>
  <p>Help out: <a href="${orig}" target="_blank" rel="noopener">download it from ePrint ↗</a> and
  upload it here. Uploads are anonymous; we check every file before it appears.</p>
  <label for="file" class="form-label mb-1">PDF file</label>
  <input type="file" id="file" name="file" class="form-control form-control-sm" accept="application/pdf,.pdf" required>
  <div class="hp" aria-hidden="true">
    <label for="website">Leave this field empty</label>
    <input type="text" id="website" name="website" tabindex="-1" autocomplete="off">
  </div>
  ${turnstileWidget(env)}
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
  ctx?: ExecutionContext,
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
  if (!hasRange) {
    const hit = await caches.default.match(pdfCacheKey(req, p));
    if (hit?.body) {
      headers.set("content-length", hit.headers.get("content-length") ?? "");
      if (!etag && hit.headers.get("etag")) headers.set("etag", hit.headers.get("etag")!);
      headers.set("x-cache", "hit");
      return new Response(hit.body, { headers });
    }
  }
  let obj: R2ObjectBody | null;
  try {
    obj = await env.PDFS.get(p.pdf_key, hasRange ? { range: req.headers } : undefined);
  } catch {
    // R2 rejects unsatisfiable/malformed ranges; answer like an origin server would.
    const h = await env.PDFS.head(p.pdf_key);
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${h?.size ?? "*"}` } });
  }
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
  if (ctx && obj.body) {
    // Edge cache for full downloads so repeat fetches don't cost R2 reads. Keyed on the object's
    // version so a re-ingest is picked up. (No-op on *.workers.dev; works on a custom domain.)
    const [a, b] = obj.body.tee();
    ctx.waitUntil(
      caches.default.put(
        pdfCacheKey(req, p),
        new Response(b, { headers: { "content-type": "application/pdf", "content-length": String(size), "cache-control": "public, max-age=604800", etag: obj.httpEtag } }),
      ),
    );
    return new Response(a, { headers });
  }
  return new Response(obj.body, { headers });
}

function pdfCacheKey(req: Request, p: { pdf_key: string | null; pdf_size: number | null; pdf_source_date: string | null }): Request {
  const v = encodeURIComponent(`${p.pdf_size ?? ""}-${p.pdf_source_date ?? ""}`);
  return new Request(new URL(`/__pdf-cache/${p.pdf_key}?v=${v}`, req.url).toString());
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
  // Anonymous uploads. Layer-1 checks here (origin, Turnstile, honeypot, rate limits, daily caps,
  // only-where-needed, PDF structure); files land in quarantine/ and are published only after the
  // offline verifier matches them to the paper.
  const id = canonicalId(year, num);
  const back = html`<p><a class="btn btn-outline-dark" href="/${id}">Back to paper ${id}</a></p>`;
  const fail = (status: number, title: string, msg: string) =>
    messagePage(env, status, title, html`<p>${msg}</p>${back}`, { cache: "no-store" });

  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) return fail(403, "Upload rejected", "Cross-site uploads are not accepted.");

  const p = await getPaper(env, id);
  if (!p) return fail(404, "Paper not found", `Paper ${id} isn’t in the mirror.`);
  if (p.withdrawn) return fail(410, "Paper withdrawn", "Withdrawn papers don’t accept uploads.");
  if (p.pdf_key && !p.pdf_maybe_stale)
    return fail(409, "We already have this paper", "This paper already has an up-to-date PDF here, so no upload is needed. Thank you!");

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
        : html`We received your PDF for paper <strong>${id}</strong>, but we couldn’t automatically confirm
          it’s this paper (we look for the title and an author’s name on the first page), so a person will
          review it before it appears.`}</p>
      <p class="small muted">If you uploaded the wrong file, no harm done — just upload the right one.</p>${back}`,
      { cache: "no-store", noindex: true },
    );

  // Honeypot: bots fill every field. Pretend success, store nothing.
  const hp = form.get("website");
  if (typeof hp === "string" && hp.trim() !== "") return thanks(false);
  if (!(await turnstileOk(env, form, req))) return fail(403, "Please complete the check", "The anti-spam check didn’t pass. Go back and try again.");
  const ip = await ipHash(env, req);
  const limited = await overLimit(env, ip);
  if (limited) return fail(429, "Slow down a little", limited);

  const file = form.get("file");
  if (!file || typeof file === "string") return fail(400, "No file", "Please choose a PDF file to upload.");
  if (file.size === 0) return fail(400, "Empty file", "That file is empty.");
  if (file.size > MAX_UPLOAD) return fail(413, "File too large", "PDFs must be 20 MB or smaller.");

  const buf = await file.arrayBuffer();
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(5, buf.byteLength)));
  if (head !== "%PDF-") return fail(415, "Not a PDF", "That file doesn’t look like a PDF (it must start with %PDF).");
  const bad = scanPdf(buf);
  if (bad) return fail(422, "PDF not accepted", bad);

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

  // Instant verification: page 1-2 text must contain the title and an author surname.
  const report = await verifyPdf(buf, p.title, parseAuthors(p.authors));
  const now = new Date().toISOString();
  const uploadId = crypto.randomUUID();
  if (report.ok) {
    // Published immediately, under a per-upload key (never overwrites an earlier copy).
    const stamp = now.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const key = `pdf/${id}/upload-${stamp}.pdf`;
    await env.PDFS.put(key, buf, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { paper_id: id, sha256: sha, source: "upload" },
    });
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE papers SET pdf_key = ?1, pdf_sha256 = ?2, pdf_size = ?3, pdf_source = 'upload',
           pdf_source_date = ?4, pdf_maybe_stale = 0 WHERE id = ?5`,
      ).bind(key, sha, buf.byteLength, now, id),
      env.DB.prepare(
        `INSERT INTO uploads (id, paper_id, r2_key, sha256, size, uploader, created_at, status, checks, ip_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, 'accepted', ?7, ?8)`,
      ).bind(uploadId, id, key, sha, buf.byteLength, now, JSON.stringify(report), ip),
    ]);
    return messagePage(
      env,
      200,
      "Thank you, it’s live!",
      html`<p>Your PDF matched paper <strong>${id}</strong> (title and authors found on the first page)
      and is now available to everyone.</p>
      <p><a class="btn btn-outline-dark" href="/${id}.pdf">Open the PDF</a>
      <a class="btn btn-outline-dark" href="/missing">Upload another missing paper</a></p>${back}`,
      { cache: "no-store", noindex: true },
    );
  }

  const key = `quarantine/${uploadId}.pdf`;
  await env.PDFS.put(key, buf, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { paper_id: id, sha256: sha, original_name: file.name.slice(0, 200) },
  });
  await env.DB.prepare(
    `INSERT INTO uploads (id, paper_id, r2_key, sha256, size, uploader, created_at, status, checks, ip_hash)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, 'pending', ?7, ?8)`,
  )
    .bind(uploadId, id, key, sha, buf.byteLength, now, JSON.stringify(report), ip)
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
    other_sources: (await getSources(env, id)).map((s) => ({ kind: s.kind, url: s.url, captured_at: s.captured_at, size: s.size })),
    bibtex: bibtex(p, env.ORIGIN_BASE),
  }, 200, "public, max-age=600");
}
