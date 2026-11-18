import type { Env } from "./db";

// Only callers that have already checked the PDF's structure, title and active content get here.
export async function saveCandidate(env: Env, paperId: string, sha: string, bytes: ArrayBuffer, ip: string, uploader: string) {
  const key = `candidates/${paperId}/${sha}.pdf`;
  const existing = await env.DB.prepare("SELECT r2_key FROM versions WHERE paper_id=? AND sha256=?")
    .bind(paperId, sha).first<{ r2_key: string }>();
  if (!existing) {
    await env.PDFS.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
  }
  await env.DB.prepare(`INSERT OR IGNORE INTO uploads
    (id,paper_id,r2_key,sha256,size,uploader,created_at,status,ip_hash)
    VALUES (?,?,?,?,?,?,?,'candidate',?)`)
    .bind(`candidate/${paperId}/${sha}`, paperId, existing?.r2_key ?? key, sha, bytes.byteLength,
      uploader, new Date().toISOString(), ip).run();
}
