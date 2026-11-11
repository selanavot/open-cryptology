import { canonicalId, getPaper, parseAuthors, type Env } from "./db";
import { API_LIMITS, ipHash, overLimit, scanPdf } from "./uploadguard";
import { verifyPdf } from "./verify";

// Upload API for AI agents: POST /api/upload/YYYY/NNNN with the PDF as the request body
// (Content-Type: application/pdf) or as a multipart "file" field. No CAPTCHA — instead, only files
// that pass the instant title + author check are accepted; anything else is rejected (422) and
// nothing is stored or queued for review. Rate-limited per IP (API_UPLOAD_LIMITER + daily caps).

const MAX_API_UPLOAD = 30 * 1024 * 1024; // larger files: use the web form (they need human review)
const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

function j(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" },
  });
}

export async function apiUpload(env: Env, req: Request, url: URL, year: number, num: number): Promise<Response> {
  const id = canonicalId(year, num);
  const p = await getPaper(env, id);
  if (!p) return j(404, { error: "not_found", id, message: `Paper ${id} isn't in the mirror.` });
  const pdfUrl = `${url.origin}/${id}.pdf`;
  if (p.withdrawn) return j(410, { error: "withdrawn", id, message: "Withdrawn papers don't accept uploads." });
  if (p.pdf_key && !p.pdf_maybe_stale)
    return j(409, { error: "already_have_it", id, pdf_url: pdfUrl, message: "This paper already has an up-to-date PDF here." });

  const ip = await ipHash(env, req);
  const limited = await overLimit(env, ip, API_LIMITS, env.API_UPLOAD_LIMITER);
  if (limited) return j(429, { error: "rate_limited", message: limited });

  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_API_UPLOAD + 64 * 1024)
    return j(413, { error: "too_large", message: "API uploads must be 30 MB or smaller; larger PDFs can be uploaded on the paper page." });

  let buf: ArrayBuffer;
  const ctype = req.headers.get("content-type") ?? "";
  if (ctype.startsWith("multipart/form-data")) {
    const f = (await req.formData()).get("file");
    if (!f || typeof f === "string") return j(400, { error: "no_file", message: 'Send the PDF as the body, or as a multipart field named "file".' });
    buf = await f.arrayBuffer();
  } else {
    buf = await req.arrayBuffer();
  }
  if (buf.byteLength === 0) return j(400, { error: "empty", message: "The request body is empty." });
  if (buf.byteLength > MAX_API_UPLOAD) return j(413, { error: "too_large", message: "API uploads must be 30 MB or smaller." });
  if (new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(5, buf.byteLength))) !== "%PDF-")
    return j(415, { error: "not_pdf", message: "That doesn't look like a PDF (it must start with %PDF)." });
  const bad = scanPdf(buf);
  if (bad) return j(422, { error: "bad_pdf", message: bad });

  const sha = toHex(await crypto.subtle.digest("SHA-256", buf));
  if (p.pdf_sha256 && p.pdf_sha256.toLowerCase() === sha)
    return j(200, { status: "already_have_it", id, pdf_url: pdfUrl, sha256: sha });

  const report = await verifyPdf(buf, p.title, parseAuthors(p.authors));
  if (report.active) return j(422, { error: "bad_pdf", message: "That PDF contains active content (scripts or embedded files)." });
  if (!report.ok) {
    return j(422, {
      error: "no_match",
      id,
      check: report,
      message:
        `This PDF doesn't look like ${id} ("${p.title}"): we couldn't find the title and an author's name on its first pages. ` +
        `Nothing was stored. If you're sure it's right, a person can upload it at ${url.origin}/${id}#upload for review.`,
    });
  }

  const now = new Date().toISOString();
  const stamp = now.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const key = `pdf/${id}/upload-${stamp}.pdf`;
  await env.PDFS.put(key, buf, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { paper_id: id, sha256: sha, source: "upload-api" },
  });
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE papers SET pdf_key = ?1, pdf_sha256 = ?2, pdf_size = ?3, pdf_source = 'upload',
         pdf_source_date = ?4, pdf_maybe_stale = 0 WHERE id = ?5`,
    ).bind(key, sha, buf.byteLength, now, id),
    env.DB.prepare(
      `INSERT INTO uploads (id, paper_id, r2_key, sha256, size, uploader, created_at, status, checks, ip_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, 'api', ?6, 'accepted', ?7, ?8)`,
    ).bind(crypto.randomUUID(), id, key, sha, buf.byteLength, now, JSON.stringify(report), ip),
    env.DB.prepare(
      `INSERT OR IGNORE INTO versions (paper_id, stamp, r2_key, sha256, size, source, source_url, captured_at, added_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'upload', NULL, ?6, ?6)`,
    ).bind(id, stamp, key, sha, buf.byteLength, now),
  ]);
  return j(201, { status: "live", id, pdf_url: pdfUrl, sha256: sha, size: buf.byteLength, check: report });
}
