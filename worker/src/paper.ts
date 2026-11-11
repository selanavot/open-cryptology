import { pendingDuplicate, queueForReview } from "./quarantine";
import { activeContentScan, ipHash, overLimit, scanPdf } from "./uploadguard";
import { verifyPdf } from "./verify";
import { turnstileOk, turnstileWidget } from "./turnstile";
import { canonicalId, confirmCurrent, eprintSize, getPaper, getSources, getVersion, getVersions, knownCopy, parseAuthors, STALE_AFTER_UPLOAD, type Env, type Paper } from "./db";
import { coverageChanged } from "./missing";
import { versionJson, versionsList } from "./versions";
import { html, safeUrl, type Html } from "./html";
import { categoryBadge, hasTex, icons, messagePage, page } from "./layout";
import { bibtex, licenseInfo, originalUrl, versionsUrl, type LicenseInfo } from "./license";
import { day, json } from "./pages";
import { ogImage, paperHead, siteOrigin } from "./seo";

export const MAX_UPLOAD = 95 * 1024 * 1024; // Workers accept request bodies up to 100 MB
/** Above this, the upload is streamed (no in-memory copy) and sent to review instead of auto-verified. */
const INLINE_MAX = 30 * 1024 * 1024;

// ---------------------------------------------------------------------------- paper page

export async function paperPage(
  env: Env,
  url: URL,
  year: number,
  num: number,
): Promise<Response> {
  const id = canonicalId(year, num);
  const orig = originalUrl(env.ORIGIN_BASE, id);
  const p = await getPaper(env, id);
  if (!p) return paperMissing(env, id, orig);
  const withdrawn = !!p.withdrawn;
  // We have a PDF, but ePrint changed the paper after it was captured: ask for the latest version.
  const outdated = !withdrawn && !!p.pdf_key && !!p.pdf_maybe_stale;

  const lic = licenseInfo(p, env.ORIGIN_BASE);
  const authors = parseAuthors(p.authors);
  const affs = parseAffiliations(p.affiliations);
  const pdfHref = p.pdf_key ? `/${id}.pdf` : null;
  const versions = await getVersions(env, id);
  const title = p.title || `Withdrawn paper ${id}`;

  const body = html`<div class="paper-row">
  <div class="paper-main">
    <h4>Paper ${id}</h4>
    ${withdrawn && html`<div class="alert alert-warning withdrawn-notice" role="note">
      <strong>Withdrawn</strong> by the authors on ePrint${p.withdrawn_on ? html` on <time datetime="${p.withdrawn_on}">${day(p.withdrawn_on)}</time>` : ""}.
      ${pdfHref ? "The last version we have is kept below for reference." : ""}
    </div>`}
    <h3 class="paper-title tex"><a href="${pdfHref ?? orig}">${title}</a></h3>
    ${authors.map((a, i) => html`<div class="author"><span class="authorName">${a}</span>${affs[i] && html`<span class="affiliation">, ${affs[i]}</span>`}</div>`)}
    ${pdfHref && !outdated ? uploadNotice(url.searchParams.get("upload")) : ""}
    ${(!pdfHref || outdated) && uploadForm(env, p, orig, uploadNotice(url.searchParams.get("upload")))}
    <h5 class="mt-3">Abstract</h5>
    <p class="paper-abstract tex">${p.abstract || "No abstract available."}</p>
  </div>
  <div id="metadata" class="paper-meta">
    <h5>Metadata</h5>
    <dl>
      <dt id="pdf-status">Available format(s)</dt>
      <dd>${withdrawn
        ? html`<div>-- withdrawn --</div>
          ${pdfHref && html`<a class="btn btn-sm btn-outline-dark mt-1" href="${pdfHref}">${icons.pdf}PDF (withdrawn)</a>
          <div class="small text-muted mt-1">Last version we have${p.pdf_source_date ? `, copy captured ${day(p.pdf_source_date)}` : ""}</div>`}
          ${!pdfHref && html`<div class="mt-1"><span class="text-muted">No PDF here yet.</span> <a href="#upload">Upload it</a></div>`}`
        : pdfHref
        ? html`<a class="btn btn-sm btn-outline-dark" href="${pdfHref}">${icons.pdf}PDF</a>
          ${outdated ? html`<div class="small mt-1"><span class="text-muted">May be outdated.</span> <a href="#upload">Upload the latest</a></div>` : ""}`
        : html`<span class="text-muted">No PDF here yet.</span> <a href="#upload">Upload it</a>`}
      </dd>
      ${p.category && html`<dt>Category</dt><dd><a rel="nofollow" href="/search?${new URLSearchParams({ q: p.category }).toString()}">${categoryBadge(p.category)}</a></dd>`}
      <dt>License</dt>
      <dd>${licenseBadge(lic)}</dd>
      <dt>History</dt>
      ${withdrawn && html`<dd>${p.withdrawn_on ? html`<time datetime="${p.withdrawn_on}">${day(p.withdrawn_on)}</time>: ` : ""}withdrawn</dd>`}
      ${!withdrawn && p.updated && p.updated !== p.submitted && html`<dd><time datetime="${p.updated}">${day(p.updated)}</time>: last updated</dd>`}
      ${p.submitted && html`<dd><time datetime="${p.submitted}">${day(p.submitted)}</time>: submitted</dd>`}
      ${versionsList(id, versions, p.pdf_key)}
      <dt>Original</dt>
      <dd><a href="${orig}" rel="noopener">View on ePrint ↗</a></dd>
    </dl>
  </div>
</div>

<p class="mt-4 mb-2"><strong>BibTeX</strong>
  <button type="button" class="ms-2 btn btn-sm btn-outline-dark" data-copy="bibtex" aria-label="Copy BibTeX to clipboard">${icons.copy}<span>Copy to clipboard</span></button></p>
<pre id="bibtex">${bibtex(p, env.ORIGIN_BASE)}</pre>
<p class="small mb-0"><a href="/?paper=${p.id}#contact">Report a problem with this paper</a></p>`;

  const origin = siteOrigin(env, url);
  const description = `${withdrawn ? "Withdrawn. " : ""}${(p.abstract ?? "").replace(/\s+/g, " ")}`.slice(0, 200);
  return page(env, {
    title: `${id}: ${title}${withdrawn ? " (withdrawn)" : ""}`,
    description,
    body,
    katex: hasTex(p.title, p.abstract),
    original: orig,
    originalLabel: `View paper ${id} on the original ePrint`,
    // This page is its own canonical, so search engines and AI search can send people and agents
    // here, where the PDF is reachable. ePrint is named as the original in the JSON-LD and the
    // Scholar tags (seo.ts), and the BibTeX cites ePrint.
    canonical: `${origin}/${id}`,
    ogType: "article",
    ogImage: ogImage(origin),
    head: paperHead({ p, origin, orig, originBase: env.ORIGIN_BASE, title, pdfUrl: pdfHref && `${origin}${pdfHref}`, lic }),
    // Pages that can still change through an upload must not be served stale from a browser cache.
    cache: url.searchParams.has("upload") ? "no-store" : pdfHref && !p.pdf_maybe_stale ? "public, max-age=600" : "no-cache",
    headers: lic.url ? { link: `<${lic.url}>; rel="license"` } : undefined,
  });
}


function licenseBadge(lic: LicenseInfo): Html {
  if (!lic.code) return html`<span class="text-muted">See the original page</span>`;
  const u = safeUrl(lic.url);
  const title = lic.retroactive ? `${lic.label} (assigned retroactively by the IACR)` : lic.label;
  return u ? html`<a class="cc" href="${u}" rel="license noopener" title="${title}">${lic.code}</a>` : html`<span class="cc" title="${title}">${lic.code}</span>`;
}




// After an upload we redirect (303) back to the paper page with ?upload=<code>, so there's no
// separate result page, Back works, and the page shows the new PDF straight away.
const UPLOAD_NOTICES: Record<string, { ok: boolean; text: string }> = {
  live: { ok: true, text: "Thank you! Your PDF matched this paper and is now live for everyone." },
  review: { ok: true, text: "Thank you! We couldn’t automatically confirm the file is this paper, so it will be checked before it appears." },
  have: { ok: true, text: "We already have that exact file. Thanks anyway!" },
  confirmed: { ok: true, text: "That’s the copy we already have, so it’s now marked as the latest version. Thank you!" },
  older: { ok: false, text: "We already have that file as an earlier version. Please upload the latest version from ePrint." },
  cross_site: { ok: false, text: "Cross-site uploads aren’t accepted." },
  not_needed: { ok: false, text: "This paper already has an up-to-date PDF here, so no upload is needed." },
  too_large: { ok: false, text: "That file is too large: PDFs must be 95 MB or smaller." },
  unreadable: { ok: false, text: "We couldn’t read that upload. Please try again." },
  turnstile: { ok: false, text: "The anti-spam check didn’t pass. Please try again." },
  rate: { ok: false, text: "Too many uploads right now. Please wait a bit and try again." },
  no_file: { ok: false, text: "Please choose a PDF file to upload." },
  empty: { ok: false, text: "That file is empty." },
  not_pdf: { ok: false, text: "That file doesn’t look like a PDF." },
  bad_pdf: { ok: false, text: "That PDF couldn’t be accepted: it looks truncated, or contains scripts or embedded files." },
};

function uploadNotice(code: string | null): Html | "" {
  const n = code ? UPLOAD_NOTICES[code] : undefined;
  if (!n) return "";
  return html`<div class="upload-notice ${n.ok ? "upload-notice-ok" : "upload-notice-err"}" role="status">${n.text}</div>`;
}

function uploadRedirect(url: URL, id: string, code: keyof typeof UPLOAD_NOTICES): Response {
  const to = new URL(`/${id}`, url);
  to.searchParams.set("upload", code);
  to.hash = UPLOAD_NOTICES[code].ok && code === "live" ? "" : "upload";
  return new Response(null, { status: 303, headers: { location: to.pathname + to.search + to.hash, "cache-control": "no-store" } });
}

/** An upload of a file we already hold: the current copy (confirms an outdated one) or an older one. */
async function knownSha(env: Env, url: URL, p: Paper, sha: string): Promise<"have" | "confirmed" | "older" | null> {
  const k = await knownCopy(env, p, sha);
  if (k === "current") {
    if (!(await confirmCurrent(env, p))) return "have";
    await coverageChanged(url.origin, p.id);
    return "confirmed";
  }
  return k === "older" ? "older" : null;
}

function uploadForm(env: Env, p: Paper, orig: string, notice: Html | "" = ""): Html {
  return html`<form id="upload" action="/${p.id}/upload" method="post" enctype="multipart/form-data" class="upload-form upload-cta">
  ${notice}
  ${p.withdrawn
    ? html`<p class="upload-cta-head"><strong>We don’t have this PDF yet.</strong></p>
  <p>Download the latest version from <a href="${versionsUrl(env.ORIGIN_BASE, p.id)}" target="_blank" rel="noopener">ePrint’s version list ↗</a>
  and upload it here.</p>`
    : p.pdf_key && eprintSize(p) != null
    ? html`<p class="upload-cta-head"><strong>ePrint has a newer PDF.</strong></p>
  <p>ePrint updated this paper’s PDF${p.updated ? html` on <time datetime="${p.updated}">${day(p.updated)}</time>` : ""};
  our copy${p.pdf_source_date ? html` (saved ${day(p.pdf_source_date)})` : ""} is an earlier version. Help out:
  <a href="${orig}" target="_blank" rel="noopener">download the latest version from ePrint ↗</a> and upload it here.</p>`
    : p.pdf_key
    ? html`<p class="upload-cta-head"><strong>Our PDF may be outdated.</strong></p>
  <p>ePrint updated this paper${p.updated ? html` on <time datetime="${p.updated}">${day(p.updated)}</time>` : ""}, after
  our copy was saved${p.pdf_source_date ? html` (${day(p.pdf_source_date)})` : ""}. That may be a new PDF, or only new
  details such as publication info. Help out:
  <a href="${orig}" target="_blank" rel="noopener">download the latest version from ePrint ↗</a> and upload it here.
  If it’s the same file we have, uploading it confirms our copy is current.</p>`
    : html`<p class="upload-cta-head"><strong>We don’t have this PDF yet.</strong></p>
  <p>Help out: <a href="${orig}" target="_blank" rel="noopener">download it from ePrint ↗</a> and
  upload it here. Uploads are anonymous. A file that matches this paper’s title and authors
  appears right away; anything else is reviewed first.</p>`}
  <label for="file" class="form-label mb-1">PDF file</label>
  <input type="file" id="file" name="file" class="form-control form-control-sm" accept="application/pdf,.pdf" required>
  <div class="hp" aria-hidden="true">
    <label for="website">Leave this field empty</label>
    <input type="text" id="website" name="website" tabindex="-1" autocomplete="off">
  </div>
  ${turnstileWidget(env)}
  <button type="submit" class="btn btn-sm btn-outline-dark mt-2">Upload PDF</button>
</form>`;
}

function paperMissing(env: Env, id: string, orig: string): Response {
  return messagePage(
    env,
    404,
    `Paper ${id} not found`,
    html`<p>This paper isn’t in the mirror. New ePrint papers show up here within a few hours.</p>
    <p><a class="btn btn-outline-dark" href="${orig}" rel="noopener">Try it on the original ePrint ↗</a></p>
    <p>Or <a href="/search">search the mirror</a>.</p>`,
    { original: orig, originalLabel: `Paper ${id} on the original ePrint`, cache: "public, max-age=60" },
  );
}

function parseAffiliations(json: string | null): (string | null)[] {
  if (!json) return [];
  try {
    const a = JSON.parse(json);
    return Array.isArray(a) ? a.map((x) => (typeof x === "string" && x.trim() ? x.trim() : null)) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------- PDF

/** /YYYY/NNNN.pdf (the default PDF = latest version), or with `stamp` one stored version. */
export async function servePdf(
  env: Env,
  req: Request,
  year: number,
  num: number,
  ctx?: ExecutionContext,
  stamp?: string,
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
  // What to serve: the default PDF, or one stored version.
  let obj0: { pdf_key: string | null; pdf_sha256: string | null; pdf_size: number | null; pdf_source_date: string | null } = p;
  let filename = `${id.replace("/", "-")}.pdf`;
  if (stamp) {
    const v = await getVersion(env, id, stamp);
    if (!v) return missing(404, "We don’t have a copy of this paper captured at that time.");
    obj0 = { pdf_key: v.r2_key, pdf_sha256: v.sha256, pdf_size: v.size, pdf_source_date: v.captured_at };
    filename = `${id.replace("/", "-")}-${stamp}.pdf`;
  } else if (!p.pdf_key) {
    return noPdfYet(env, req, p, orig);
  }
  const pdfKey = obj0.pdf_key!;

  const lic = licenseInfo(p, env.ORIGIN_BASE);
  const etag = obj0.pdf_sha256 ? `"${obj0.pdf_sha256}"` : null;
  const headers = new Headers({
    "content-type": "application/pdf",
    "content-disposition": `inline; filename="${filename}"`,
    "cache-control": stamp ? "public, max-age=604800" : "public, max-age=86400",
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
  });
  // A stored older version points search engines at the paper's current PDF; the current PDF is
  // its own canonical (no header needed).
  const links: string[] = [];
  if (lic.url) links.push(`<${lic.url}>; rel="license"`);
  if (stamp) links.push(`<${siteOrigin(env, new URL(req.url))}/${id}.pdf>; rel="canonical"`);
  if (links.length) headers.set("link", links.join(", "));
  if (lic.code) headers.set("x-license", lic.code);
  if (etag) headers.set("etag", etag);
  if (!stamp && p.pdf_maybe_stale) headers.set("x-mirror-note", "may-be-older-revision");
  if (p.withdrawn) headers.set("x-withdrawn", "1");
  if (obj0.pdf_source_date) headers.set("x-captured-at", obj0.pdf_source_date);

  const inm = req.headers.get("if-none-match");
  if (etag && inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers });
  }

  if (req.method === "HEAD") {
    const h = await env.PDFS.head(pdfKey);
    if (!h) return missing(404, "The mirrored file is missing from storage.");
    headers.set("content-length", String(h.size));
    if (!etag) headers.set("etag", h.httpEtag);
    return new Response(null, { headers });
  }

  const hasRange = req.headers.has("range");
  if (!hasRange) {
    const hit = await caches.default.match(pdfCacheKey(req, obj0));
    if (hit?.body) {
      headers.set("content-length", hit.headers.get("content-length") ?? "");
      if (!etag && hit.headers.get("etag")) headers.set("etag", hit.headers.get("etag")!);
      headers.set("x-cache", "hit");
      return new Response(hit.body, { headers });
    }
  }
  let obj: R2ObjectBody | null;
  try {
    obj = await env.PDFS.get(pdfKey, hasRange ? { range: req.headers } : undefined);
  } catch {
    // R2 rejects unsatisfiable/malformed ranges; answer like an origin server would.
    const h = await env.PDFS.head(pdfKey);
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
        pdfCacheKey(req, obj0),
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


/** 404 for a paper we have no PDF for yet (410 if it was withdrawn): tell the reader (person or
 *  agent) how to fill the gap. Browsers get a page; agents get plain text (or JSON if they ask for
 *  it) — never HTML at a .pdf URL. */
function noPdfYet(env: Env, req: Request, p: Paper, orig: string): Response {
  const origin = new URL(req.url).origin;
  const upload = `${origin}/${p.id}#upload`;
  const accept = req.headers.get("accept") ?? "";
  const headers = {
    "cache-control": "no-cache",
    "x-upload-url": upload,
    link: `<${orig}>; rel="alternate"; title="original on ePrint", <${upload}>; rel="help"; title="upload the PDF"`,
  };
  if (p.withdrawn) {
    const vers = versionsUrl(env.ORIGIN_BASE, p.id);
    const message =
      `ePrint ${p.id} was withdrawn and we don't have its PDF yet. Its earlier versions are on ePrint's version list (${vers}). ` +
      `Please download the latest one and upload it: POST it to ${origin}/api/upload/${p.id} or use the form at ${upload}.`;
    if (accept.includes("text/html")) {
      return messagePage(
        env,
        410,
        `We don’t have the PDF for ${p.id} yet`,
        html`<p>Download the latest version from ePrint’s version list and upload it here.</p>
        <p><a class="btn btn-outline-dark" href="${vers}" target="_blank" rel="noopener">ePrint version list ↗</a>
        <a class="btn btn-outline-dark" href="/${p.id}#upload">Upload it</a></p>`,
        { original: orig, cache: "no-cache", headers },
      );
    }
    if (accept.includes("application/json")) {
      return new Response(JSON.stringify({ error: "withdrawn", id: p.id, title: p.title, original_url: orig, upload_url: upload, api_upload_url: `${origin}/api/upload/${p.id}`, message }, null, 2), {
        status: 410,
        headers: { "content-type": "application/json; charset=utf-8", ...headers },
      });
    }
    return new Response(`410 Gone: ${message}\n`, { status: 410, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
  }
  if (accept.includes("text/html")) {
    return messagePage(
      env,
      404,
      `We don’t have the PDF for ${p.id} yet`,
      html`<p><strong>${p.title}</strong></p>
      <p>Help fill the gap: <a href="${orig}" target="_blank" rel="noopener">download it from ePrint ↗</a>,
      then upload it here so everyone (people and AI agents) can get it. Uploads are anonymous, and a
      file that matches the paper goes live right away; anything else is reviewed first.</p>
      <p><a class="btn btn-outline-dark" href="/${p.id}#upload">Upload the PDF</a>
      <a class="btn btn-outline-dark" href="${orig}" target="_blank" rel="noopener">Get it on ePrint ↗</a></p>`,
      { original: orig, cache: "no-cache", headers },
    );
  }
  const message =
    `We don't have the PDF for ePrint ${p.id} ("${p.title}") yet. ` +
    `The original is at ${orig} (ePrint's PDF download is behind a bot check, so a person may need to download it). ` +
    `Once you have the PDF, please upload it so everyone, including other AI agents, can get it: ` +
    `POST it to ${origin}/api/upload/${p.id} (e.g. curl -X POST --data-binary @paper.pdf -H "Content-Type: application/pdf" ${origin}/api/upload/${p.id}), ` +
    `or use the form at ${upload}. ` +
    `Uploads are anonymous. A file that matches the paper goes live right away (HTTP 201); otherwise it is stored and ` +
    `a person reviews it (HTTP 202 "queued_for_review": received, pending review, no need to upload it again).`;
  if (accept.includes("application/json")) {
    return new Response(JSON.stringify({ error: "no_pdf_yet", id: p.id, title: p.title, original_url: orig, upload_url: upload, api_upload_url: `${origin}/api/upload/${p.id}`, message }, null, 2), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8", ...headers },
    });
  }
  return new Response(`404 Not Found: ${message}\n`, { status: 404, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
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
  const fail = (_status: number, code: keyof typeof UPLOAD_NOTICES) => uploadRedirect(url, id, code);

  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) return fail(403, "cross_site");

  const p = await getPaper(env, id);
  if (!p) return messagePage(env, 404, "Paper not found", html`<p>Paper ${id} isn’t in the mirror.</p>${back}`, { cache: "no-store" });
  if (p.pdf_key && !p.pdf_maybe_stale)
    return fail(409, "not_needed");

  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_UPLOAD + 64 * 1024) return fail(413, "too_large");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "unreadable");
  }
  const thanks = (_dup: boolean) => uploadRedirect(url, id, "review");

  // Honeypot: bots fill every field. Pretend success, store nothing.
  const hp = form.get("website");
  if (typeof hp === "string" && hp.trim() !== "") return thanks(false);
  if (!(await turnstileOk(env, form, req))) return fail(403, "turnstile");
  const ip = await ipHash(env, req);
  const limited = await overLimit(env, ip);
  if (limited) return fail(429, "rate");

  const file = form.get("file");
  if (!file || typeof file === "string") return fail(400, "no_file");
  if (file.size === 0) return fail(400, "empty");
  if (file.size > MAX_UPLOAD) return fail(413, "too_large");

  if (file.size > INLINE_MAX) return largeUpload(env, url, p, file, ip, thanks, fail);

  const buf = await file.arrayBuffer();
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(5, buf.byteLength)));
  if (head !== "%PDF-") return fail(415, "not_pdf");
  const bad = scanPdf(buf);
  if (bad) return fail(422, "bad_pdf");

  const sha = toHex(await crypto.subtle.digest("SHA-256", buf));
  const known = await knownSha(env, url, p, sha);
  if (known) return uploadRedirect(url, id, known);
  if (await pendingDuplicate(env, id, sha)) return thanks(true);

  // Instant verification: page 1-2 text must contain the title and an author surname.
  // PDFs with active content (scripts, attachments) are never auto-published: they go to review.
  const rawActive = activeContentScan(buf);
  const report = await verifyPdf(buf, p.title, parseAuthors(p.authors));
  if (rawActive && !report.active) report.active = rawActive;
  if (report.active) report.ok = false;
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
           pdf_source_date = ?4, pdf_maybe_stale = ${STALE_AFTER_UPLOAD} WHERE id = ?5`,
      ).bind(key, sha, buf.byteLength, now, id),
      env.DB.prepare(
        `INSERT INTO uploads (id, paper_id, r2_key, sha256, size, uploader, created_at, status, checks, ip_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, 'accepted', ?7, ?8)`,
      ).bind(uploadId, id, key, sha, buf.byteLength, now, JSON.stringify(report), ip),
      env.DB.prepare(
        `INSERT OR IGNORE INTO versions (paper_id, stamp, r2_key, sha256, size, source, source_url, captured_at, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'upload', NULL, ?6, ?6)`,
      ).bind(id, stamp, key, sha, buf.byteLength, now),
    ]);
    await coverageChanged(url.origin, id);
    return uploadRedirect(url, id, "live");
  }

  await queueForReview(env, url.origin, {
    paperId: id, body: buf, size: buf.byteLength, sha, checks: JSON.stringify(report), ip, uploader: null, originalName: file.name,
  });
  return thanks(false);
}

/** Large uploads (30–95 MB): streamed into quarantine without buffering a second copy, hashed with
 *  a DigestStream, and queued for a person to review (parsing them in the Worker risks its 128 MB
 *  memory limit). */
async function largeUpload(
  env: Env,
  url: URL,
  p: Paper,
  file: File,
  ip: string,
  thanks: (dup: boolean) => Response,
  fail: (status: number, code: keyof typeof UPLOAD_NOTICES) => Response,
): Promise<Response> {
  const head = await file.slice(0, 5).text();
  if (head !== "%PDF-") return fail(415, "not_pdf");
  const tail = await file.slice(Math.max(0, file.size - 2048)).text();
  if (!tail.includes("%%EOF")) return fail(422, "bad_pdf");
  const ds = new crypto.DigestStream("SHA-256");
  await file.stream().pipeTo(ds);
  const sha = toHex(await ds.digest);
  const known = await knownSha(env, url, p, sha);
  if (known) return uploadRedirect(url, p.id, known);
  if (await pendingDuplicate(env, p.id, sha)) return thanks(true);
  await queueForReview(env, url.origin, {
    paperId: p.id, body: file, size: file.size, sha, ip, uploader: null, originalName: file.name,
    checks: JSON.stringify({ ok: false, skipped: "large file (over 30 MB), not checked automatically" }),
  });
  return thanks(false);
}

// ---------------------------------------------------------------------------- API

export async function apiPaper(
  env: Env,
  url: URL,
  year: number,
  num: number,
): Promise<Response> {
  const id = canonicalId(year, num);
  const origin = url.origin;
  const orig = originalUrl(env.ORIGIN_BASE, id);
  const p = await getPaper(env, id);
  if (!p) {
    return json(
      { error: "not_found", id, original_url: orig },
      404,
      "public, max-age=60",
    );
  }
  const lic = licenseInfo(p, env.ORIGIN_BASE);
  const [sources, versions] = await Promise.all([getSources(env, id), getVersions(env, id)]);
  const affs = p.affiliations ? parseAffiliations(p.affiliations) : null;
  return json({
    id,
    url: `${origin}/${id}`,
    original_url: orig,
    title: p.title || null,
    authors: parseAuthors(p.authors),
    affiliations: affs && affs.some(Boolean) ? affs : null,
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
    dates: { submitted: p.submitted, updated: p.updated, withdrawn: p.withdrawn ? p.withdrawn_on : null },
    withdrawn: !!p.withdrawn,
    withdrawn_on: p.withdrawn ? p.withdrawn_on : null,
    pdf: p.pdf_key
      ? {
          url: `${origin}/${id}.pdf`,
          sha256: p.pdf_sha256,
          size: p.pdf_size,
          source: p.pdf_source,
          source_date: p.pdf_source_date,
          maybe_stale: !!p.pdf_maybe_stale,
          // true: ePrint's current PDF has a different size (a newer PDF exists); false: same size
          // (ours is current); null: unknown.
          newer_on_eprint: eprintSize(p) == null || p.pdf_size == null ? null : eprintSize(p) !== p.pdf_size,
          withdrawn: !!p.withdrawn,
        }
      : null,
    ...(p.pdf_key
      ? {}
      : {
          upload_url: `${origin}/${id}#upload`,
          api_upload_url: `${origin}/api/upload/${id}`,
          missing_pdf: p.withdrawn
            ? `Withdrawn; no PDF here yet. Download the latest version from ${versionsUrl(env.ORIGIN_BASE, id)} and upload it at ${origin}/${id}#upload.`
            : `No PDF here yet. A person can download it from ${originalUrl(env.ORIGIN_BASE, id)} and upload it at ${origin}/${id}#upload so everyone can get it.`,
        }),
    versions: versions.map((v) => versionJson(origin, id, v, p.pdf_key)),
    other_sources: sources.map((s) => ({ kind: s.kind, url: s.url, captured_at: s.captured_at, size: s.size })),
    bibtex: bibtex(p, env.ORIGIN_BASE),
  }, 200, p.withdrawn ? "public, max-age=3600" : "public, max-age=600");
}
