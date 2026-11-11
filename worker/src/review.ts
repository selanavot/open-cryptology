import { getPaper, parseAuthors, type Env } from "./db";
import { html } from "./html";
import { messagePage } from "./layout";

// Maintainer review of uploads that couldn't be verified automatically.
// Each pending upload triggers an email with a link to /review/<uploadId>. Review pages are behind
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

/** Email the maintainer about an upload waiting for review. Never throws. */
export async function notifyReview(env: Env, origin: string, uploadId: string, paperId: string, title: string, checks: string): Promise<void> {
  if (!env.MAILER || !env.CONTACT_TO || !env.CONTACT_FROM) return;
  try {
    const link = `${origin}/review/${uploadId}`;
    await env.MAILER.send({
      from: { name: `${env.SITE_NAME} uploads`, email: env.CONTACT_FROM },
      to: env.CONTACT_TO,
      subject: `[${env.SITE_NAME}] Upload needs review: ${paperId}`,
      text: [
        `An upload for ${paperId} couldn't be verified automatically.`,
        "",
        `Paper: ${title}`,
        `Check: ${checks}`,
        "",
        `Review it (view the PDF, then approve or reject): ${link}`,
      ].join("\n"),
    });
  } catch (e) {
    console.error("review email failed", e instanceof Error ? e.message : String(e));
  }
}

const REVIEW_RE = /^\/review\/([0-9a-f-]{36})(\/file)?$/;

export function isReviewPath(path: string): boolean {
  return REVIEW_RE.test(path);
}

export async function handleReview(req: Request, env: Env, url: URL): Promise<Response> {
  const m = REVIEW_RE.exec(url.pathname)!;
  const uploadId = m[1];
  const isPost = req.method === "POST";
  if (!(await accessIdentity(req, env))) {
    return messagePage(env, 403, "Maintainers only", html`<p>Reviewing uploads requires the maintainer’s login.</p>`, { cache: "no-store", noindex: true });
  }
  if (isPost && req.headers.get("origin") && req.headers.get("origin") !== url.origin) {
    return messagePage(env, 403, "Rejected", html`<p>Cross-site requests aren’t accepted.</p>`, { cache: "no-store", noindex: true });
  }
  const form = isPost ? await req.formData() : null;

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
          `UPDATE papers SET pdf_key = ?1, pdf_sha256 = ?2, pdf_size = ?3, pdf_source = 'upload', pdf_source_date = ?4, pdf_maybe_stale = 0 WHERE id = ?5`,
        ).bind(key, up.sha256, up.size, now, p.id),
        env.DB.prepare(
          `INSERT OR IGNORE INTO versions (paper_id, stamp, r2_key, sha256, size, source, source_url, captured_at, added_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 'upload', NULL, ?6, ?6)`,
        ).bind(p.id, stamp, key, up.sha256, up.size, now),
        env.DB.prepare("UPDATE uploads SET status = 'accepted', r2_key = ?2 WHERE id = ?1").bind(up.id, key),
      ]);
      await env.PDFS.delete(up.r2_key);
      return messagePage(env, 200, "Approved", html`<p>The PDF for <a href="/${p.id}">${p.id}</a> is now live.</p>`, { cache: "no-store", noindex: true });
    }
    if (action === "reject") {
      await env.PDFS.delete(up.r2_key);
      await env.DB.prepare("UPDATE uploads SET status = 'rejected' WHERE id = ?1").bind(up.id).run();
      return messagePage(env, 200, "Rejected", html`<p>The upload for <a href="/${p.id}">${p.id}</a> was deleted.</p>`, { cache: "no-store", noindex: true });
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
    Automatic check: <code>${up.checks ?? "none"}</code></p>
    <p><a class="btn btn-outline-dark" href="${fileHref}" target="_blank" rel="noopener">Open the uploaded PDF ↗</a>
    <a class="btn btn-outline-dark" href="/${p.id}" target="_blank" rel="noopener">Paper page ↗</a>
    <a class="btn btn-outline-dark" href="${env.ORIGIN_BASE}/${p.id}" target="_blank" rel="noopener">ePrint page ↗</a></p>
    ${up.status === "pending"
      ? html`<form method="post" action="/review/${up.id}" class="d-flex gap-2">
      <button class="btn btn-outline-dark" name="action" value="approve">Approve: publish it</button>
      <button class="btn btn-outline-dark" name="action" value="reject">Reject: delete it</button>
    </form>`
      : html`<p>This upload was already ${up.status}.</p>`}`,
    { cache: "no-store", noindex: true },
  );
}
