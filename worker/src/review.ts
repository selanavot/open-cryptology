import { getPaper, parseAuthors, STALE_AFTER_UPLOAD, type Env } from "./db";
import { coverageChanged } from "./years";
import { html } from "./html";
import { messagePage } from "./layout";

// Maintainer review of uploads that couldn't be verified automatically.
// /review lists every pending upload (newest first); /review/<uploadId> shows one. Pending uploads
// trigger a (throttled) summary email linking to /review (quarantine.ts). Review pages are behind
// Cloudflare Access (the maintainer's Cloudflare login): an Access application must cover /review*
// on every hostname, and the Worker additionally verifies the Access JWT (signature via the team's
// JWKS, audience, expiry), so a forged header can't get in even if Access were misconfigured.
// Approve / Reject are POSTs, so link scanners in email clients can't trigger them.

interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }
let jwksCache: { at: number; keys: Jwk[] } | null = null;

function b64urlBytes(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** Returns the verified Access identity (email), or null. */
export async function accessIdentity(req: Request, env: Env): Promise<string | null> {
  if (env.REVIEW_DEV_BYPASS === "1") return "local-dev";
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const [h, pl, sig] = token.split(".");
  if (!h || !pl || !sig) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlBytes(h))) as { kid?: string; alg?: string };
    const payload = JSON.parse(new TextDecoder().decode(b64urlBytes(pl))) as { aud?: string | string[]; exp?: number; iss?: string; email?: string };
    if (header.alg !== "RS256") return null;
    if (!jwksCache || Date.now() - jwksCache.at > 3600_000) {
      const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
      jwksCache = { at: Date.now(), keys: ((await r.json()) as { keys: Jwk[] }).keys };
    }
    const jwk = jwksCache.keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(sig), new TextEncoder().encode(`${h}.${pl}`));
    if (!ok) return null;
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const allowed = env.ACCESS_AUD.split(",").map((a) => a.trim());
    if (!auds.some((a) => a && allowed.includes(a))) return null;
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
    return payload.email ?? "access-user";
  } catch {
    return null;
  }
}

interface UploadRow {
  id: string;
  paper_id: string;
  r2_key: string;
  sha256: string;
  size: number;
  created_at: string;
  status: string;
  checks: string | null;
}

const REVIEW_RE = /^\/review\/([0-9a-f-]{36})(\/file)?$/;
const INDEX_RE = /^\/review\/?$/;

export function isReviewPath(path: string): boolean {
  return INDEX_RE.test(path) || REVIEW_RE.test(path);
}

/** One line summary of a stored verification report (uploads.checks). */
function checkSummary(checks: string | null): string {
  if (!checks) return "no check";
  try {
    const c = JSON.parse(checks) as { titleScore?: number; authorHit?: string | null; noText?: boolean; error?: string; skipped?: string; active?: string };
    if (c.active) return `⚠ contains ${c.active}`;
    if (c.skipped) return c.skipped;
    if (c.error) return `couldn’t parse: ${c.error}`;
    const parts = [`title ${Math.round((c.titleScore ?? 0) * 100)}%`, c.authorHit ? `author found (${c.authorHit})` : "no author found"];
    if (c.noText) parts.push("no readable text on pages 1–2");
    return parts.join(" · ");
  } catch {
    return checks.slice(0, 200);
  }
}

const NO_STORE = { cache: "no-store", noindex: true } as const;

/** All pending uploads, newest first, with links to review each one. */
async function reviewIndex(env: Env, url: URL): Promise<Response> {
  const r = await env.DB.prepare(
    `SELECT u.id, u.paper_id, u.size, u.created_at, u.checks, u.uploader, p.title, (p.pdf_key IS NOT NULL) AS has_pdf
       FROM uploads u LEFT JOIN papers p ON p.id = u.paper_id
      WHERE u.status = 'pending' ORDER BY u.created_at DESC LIMIT 500`,
  ).all<{ id: string; paper_id: string; size: number; created_at: string; checks: string | null; uploader: string | null; title: string | null; has_pdf: number }>();
  const rows = r.results ?? [];
  const done = url.searchParams.get("done");
  const action = url.searchParams.get("action");
  return messagePage(
    env,
    200,
    "Uploads waiting for review",
    html`${done && /^\d{4}\/\d+$/.test(done) && (action === "approved" || action === "rejected")
      ? html`<p class="upload-notice upload-notice-ok" role="status">Upload for <a href="/${done}">${done}</a> ${action}.</p>`
      : ""}
    <p>${rows.length === 0 ? "Nothing is waiting for review." : `${rows.length}${rows.length === 500 ? "+" : ""} pending, newest first.`}</p>
    <ol class="review-list">
      ${rows.map(
        (u) => html`<li style="margin-bottom:1em">
        <a href="/review/${u.id}"><strong>${u.paper_id}</strong></a> ${u.title ?? "(paper not in the mirror)"}
        ${u.has_pdf ? html`<strong>(paper already has a PDF now)</strong>` : ""}<br>
        <span class="small">${u.created_at.slice(0, 16).replace("T", " ")} UTC · ${(u.size / 1e6).toFixed(1)} MB ·
        ${u.uploader === "api" ? "agent API" : "web form"} · ${checkSummary(u.checks)}</span><br>
        <span class="small"><a href="/review/${u.id}">Review</a> · <a href="/review/${u.id}/file" target="_blank" rel="noopener">PDF ↗</a> ·
        <a href="/${u.paper_id}" target="_blank" rel="noopener">paper page ↗</a> ·
        <a href="${env.ORIGIN_BASE}/${u.paper_id}" target="_blank" rel="noopener">ePrint ↗</a></span>
        <form method="post" action="/review/${u.id}" style="display:inline">
          <input type="hidden" name="back" value="list">
          <button class="btn btn-sm btn-outline-dark" name="action" value="approve">Approve</button>
          <button class="btn btn-sm btn-outline-dark" name="action" value="reject">Reject</button>
        </form>
      </li>`,
      )}
    </ol>`,
    NO_STORE,
  );
}

export async function handleReview(req: Request, env: Env, url: URL): Promise<Response> {
  const isPost = req.method === "POST";
  if (!(await accessIdentity(req, env))) {
    return messagePage(env, 403, "Maintainers only", html`<p>Reviewing uploads requires the maintainer’s login.</p>`, { cache: "no-store", noindex: true });
  }
  if (INDEX_RE.test(url.pathname)) {
    if (isPost) return messagePage(env, 405, "Method not allowed", html`<p>Use the buttons next to each upload.</p>`, NO_STORE);
    return reviewIndex(env, url);
  }
  const m = REVIEW_RE.exec(url.pathname)!;
  const uploadId = m[1];
  if (isPost && req.headers.get("origin") && req.headers.get("origin") !== url.origin) {
    return messagePage(env, 403, "Rejected", html`<p>Cross-site requests aren’t accepted.</p>`, { cache: "no-store", noindex: true });
  }
  const form = isPost ? await req.formData() : null;
  /** Approve/reject from the list page: go back to it. */
  const backToList = (paperId: string, action: string) =>
    form?.get("back") === "list"
      ? new Response(null, { status: 303, headers: { location: `/review?done=${encodeURIComponent(paperId)}&action=${action}`, "cache-control": "no-store" } })
      : null;

  const up = await env.DB.prepare("SELECT * FROM uploads WHERE id = ?1").bind(uploadId).first<UploadRow>();
  if (!up) return messagePage(env, 404, "Upload not found", html`<p>No such upload.</p>`, { cache: "no-store", noindex: true });

  if (m[2]) {
    if (up.status !== "pending") return messagePage(env, 410, "Already handled", html`<p>This upload was already ${up.status}.</p>`, { cache: "no-store", noindex: true });
    const obj = await env.PDFS.get(up.r2_key);
    if (!obj) return messagePage(env, 404, "File missing", html`<p>The uploaded file is gone.</p>`, { cache: "no-store", noindex: true });
    return new Response(obj.body, {
      headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="upload-${up.paper_id.replace("/", "-")}.pdf"`, "cache-control": "no-store", "x-robots-tag": "noindex" },
    });
  }

  const p = await getPaper(env, up.paper_id);
  if (!p) return messagePage(env, 404, "Paper not found", html`<p>Paper ${up.paper_id} isn’t in the mirror.</p>`, { cache: "no-store", noindex: true });

  if (isPost) {
    if (up.status !== "pending") return messagePage(env, 409, "Already handled", html`<p>This upload was already ${up.status}.</p><p><a href="/${p.id}">Paper ${p.id}</a></p>`, { cache: "no-store", noindex: true });
    const action = String(form!.get("action") ?? "");
    if (action === "approve") {
      const obj = await env.PDFS.get(up.r2_key);
      if (!obj) return messagePage(env, 404, "File missing", html`<p>The uploaded file is gone.</p>`, { cache: "no-store", noindex: true });
      const now = new Date().toISOString();
      const stamp = now.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
      const key = `pdf/${p.id}/upload-${stamp}.pdf`;
      await env.PDFS.put(key, obj.body, { httpMetadata: { contentType: "application/pdf" }, customMetadata: { paper_id: p.id, sha256: up.sha256, source: "upload" } });
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE papers SET pdf_key = ?1, pdf_sha256 = ?2, pdf_size = ?3, pdf_source = 'upload', pdf_source_date = ?4, pdf_maybe_stale = ${STALE_AFTER_UPLOAD} WHERE id = ?5`,
        ).bind(key, up.sha256, up.size, now, p.id),
        env.DB.prepare(
          `INSERT OR IGNORE INTO versions (paper_id, stamp, r2_key, sha256, size, source, source_url, captured_at, added_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 'upload', NULL, ?6, ?6)`,
        ).bind(p.id, stamp, key, up.sha256, up.size, now),
        env.DB.prepare("UPDATE uploads SET status = 'accepted', r2_key = ?2 WHERE id = ?1").bind(up.id, key),
      ]);
      await env.PDFS.delete(up.r2_key);
      await coverageChanged(url.origin, p.id);
      return backToList(p.id, "approved") ?? messagePage(env, 200, "Approved", html`<p>The PDF for <a href="/${p.id}">${p.id}</a> is now live.</p><p><a href="/review">All pending uploads</a></p>`, { cache: "no-store", noindex: true });
    }
    if (action === "reject") {
      await env.PDFS.delete(up.r2_key);
      await env.DB.prepare("UPDATE uploads SET status = 'rejected' WHERE id = ?1").bind(up.id).run();
      await coverageChanged(url.origin, p.id);
      return backToList(p.id, "rejected") ?? messagePage(env, 200, "Rejected", html`<p>The upload for <a href="/${p.id}">${p.id}</a> was deleted.</p><p><a href="/review">All pending uploads</a></p>`, { cache: "no-store", noindex: true });
    }
    return messagePage(env, 400, "Unknown action", html`<p>Choose approve or reject.</p>`, { cache: "no-store", noindex: true });
  }

  const authors = parseAuthors(p.authors);
  const fileHref = `/review/${up.id}/file`;
  return messagePage(
    env,
    200,
    `Review upload for ${p.id}`,
    html`<p><strong>${p.title}</strong><br>${authors.join(", ")}</p>
    <p class="small">Uploaded ${up.created_at.slice(0, 16).replace("T", " ")} UTC · ${(up.size / 1e6).toFixed(1)} MB · status <strong>${up.status}</strong><br>
    Automatic check: ${checkSummary(up.checks)} <code>${up.checks ?? ""}</code></p>
    <p><a class="btn btn-outline-dark" href="${fileHref}" target="_blank" rel="noopener">Open the uploaded PDF ↗</a>
    <a class="btn btn-outline-dark" href="/${p.id}" target="_blank" rel="noopener">Paper page ↗</a>
    <a class="btn btn-outline-dark" href="${env.ORIGIN_BASE}/${p.id}" target="_blank" rel="noopener">ePrint page ↗</a></p>
    ${up.status === "pending"
      ? html`<form method="post" action="/review/${up.id}" class="d-flex gap-2">
      <button class="btn btn-outline-dark" name="action" value="approve">Approve: publish it</button>
      <button class="btn btn-outline-dark" name="action" value="reject">Reject: delete it</button>
    </form>`
      : html`<p>This upload was already ${up.status}.</p>`}
    <p class="small"><a href="/review">All pending uploads</a></p>`,
    { cache: "no-store", noindex: true },
  );
}
