import { canonicalId, getPaper, parseAuthors, type Env } from "./db";
import { pendingDuplicate, queueForReview } from "./quarantine";
import { activeContentScan, API_LIMITS, ipHash, overLimit, reviewQueueFull, scanPdf } from "./uploadguard";
import { verifyPdf } from "./verify";

// Upload API for AI agents: POST /api/upload/YYYY/NNNN with the PDF as the request body
// (Content-Type: application/pdf) or as a multipart "file" field. No CAPTCHA. Files that pass the
// instant title + author check go live (201). A well-formed PDF that doesn't pass is kept in
// quarantine for the maintainer to review, like web-form uploads (202 queued_for_review), so an
// agent never needs to retry. Broken files, active content and unneeded uploads are refused (4xx).
// Rate-limited per IP (API_UPLOAD_LIMITER + daily caps, plus a cap on uploads queued for review).

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

  const queuedMsg = (again: boolean) =>
    (again ? "We already received this exact file; it is waiting for review. " : "Received, thank you. ") +
    `We couldn't automatically confirm from the title and author names on its first pages that this PDF is ${id} ("${p.title}"), ` +
    "so a person will review it before it goes live. There is no need to upload it again.";
  const dup = await pendingDuplicate(env, id, sha);
  if (dup) {
    let check: unknown = null;
    try {
      check = dup.checks ? JSON.parse(dup.checks) : null;
    } catch {}
    return j(202, { status: "queued_for_review", id, sha256: sha, check, message: queuedMsg(true) });
  }

  const rawActive = activeContentScan(buf);
  const report = await verifyPdf(buf, p.title, parseAuthors(p.authors));
  if (rawActive && !report.active) report.active = rawActive;
  if (report.active) {
    // Active content (scripts, attachments): never auto-published, but kept for a person to review.
    const full = await reviewQueueFull(env, ip);
    if (full) return j(429, { error: "review_queue_full", id, check: report, message: full });
    await queueForReview(env, url.origin, { paperId: id, body: buf, size: buf.byteLength, sha, checks: JSON.stringify({ ...report, ok: false }), ip, uploader: "api" });
    return j(202, {
      status: "queued_for_review", id, sha256: sha, size: buf.byteLength, check: report,
      message: `Received, thank you. This PDF contains active content (${report.active}), so a person will review it before it goes live. There is no need to upload it again.`,
    });
  }
  if (report.error) return j(422, { error: "bad_pdf", message: `We couldn't read that PDF (${report.error.slice(0, 200)}).` });
  if (!report.ok) {
    const full = await reviewQueueFull(env, ip);
    if (full) return j(429, { error: "review_queue_full", id, check: report, message: full });
    await queueForReview(env, url.origin, { paperId: id, body: buf, size: buf.byteLength, sha, checks: JSON.stringify(report), ip, uploader: "api" });
    return j(202, { status: "queued_for_review", id, sha256: sha, size: buf.byteLength, check: report, message: queuedMsg(false) });
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
