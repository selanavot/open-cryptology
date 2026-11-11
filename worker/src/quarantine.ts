import { type Env } from "./db";
import { coverageChanged } from "./missing";

// Uploads that couldn't be verified automatically wait in R2 under quarantine/ (and in `uploads`
// with status 'pending') until the maintainer approves or rejects them at /review (review.ts).
// Both upload paths (web form and agent API) queue here, and the maintainer gets at most one
// email per REVIEW_EMAIL_EVERY summarizing everything pending, so a batch of queued uploads from an
// agent doesn't flood the inbox. The cron (index.ts) catches uploads queued during the quiet period.

const REVIEW_EMAIL_EVERY = 15 * 60 * 1000;
const LAST_SENT_KEY = "review_email_last";

export interface QueueArgs {
  paperId: string;
  body: ArrayBuffer | File;
  size: number;
  sha: string;
  /** JSON verification report (or a note why it was skipped). */
  checks: string;
  ip: string;
  /** 'api' for the agent API, null for the web form. */
  uploader: string | null;
  originalName?: string;
}

/** Store an upload in quarantine for review, then (maybe) email the maintainer. Returns its id. */
export async function queueForReview(env: Env, origin: string, a: QueueArgs): Promise<string> {
  const uploadId = crypto.randomUUID();
  const key = `quarantine/${uploadId}.pdf`;
  await env.PDFS.put(key, a.body, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { paper_id: a.paperId, sha256: a.sha, ...(a.originalName ? { original_name: a.originalName.slice(0, 200) } : {}) },
  });
  await env.DB.prepare(
    `INSERT INTO uploads (id, paper_id, r2_key, sha256, size, uploader, created_at, status, checks, ip_hash)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9)`,
  )
    .bind(uploadId, a.paperId, key, a.sha, a.size, a.uploader, new Date().toISOString(), a.checks, a.ip)
    .run();
  await coverageChanged(origin, a.paperId);
  await notifyReview(env, origin);
  return uploadId;
}

/** The pending upload for this paper with this exact content, if any. */
export async function pendingDuplicate(env: Env, paperId: string, sha: string): Promise<{ id: string; checks: string | null } | null> {
  return env.DB.prepare("SELECT id, checks FROM uploads WHERE paper_id = ?1 AND sha256 = ?2 AND status = 'pending' LIMIT 1")
    .bind(paperId, sha)
    .first<{ id: string; checks: string | null }>();
}

/**
 * Email the maintainer a summary of pending uploads, unless one was sent in the last 15 minutes or
 * nothing new is pending since the last email. Never throws.
 */
export async function notifyReview(env: Env, origin: string): Promise<void> {
  if (!env.MAILER || !env.CONTACT_TO || !env.CONTACT_FROM) return;
  try {
    const now = new Date();
    const last = await env.DB.prepare("SELECT value FROM meta WHERE key = ?1").bind(LAST_SENT_KEY).first<{ value: string }>();
    const lastAt = last?.value ?? "";
    if (lastAt && now.getTime() - Date.parse(lastAt) < REVIEW_EMAIL_EVERY) {
      console.log("review email throttled; last sent", lastAt);
      return;
    }
    const pending = await env.DB.prepare(
      `SELECT u.paper_id, u.created_at, p.title FROM uploads u LEFT JOIN papers p ON p.id = u.paper_id
        WHERE u.status = 'pending' ORDER BY u.created_at DESC LIMIT 20`,
    ).all<{ paper_id: string; created_at: string; title: string | null }>();
    const rows = pending.results ?? [];
    if (!rows.length || rows[0].created_at <= lastAt) return; // nothing new since the last email
    // Claim the slot atomically, so concurrent uploads send one email between them.
    const claim = await env.DB.prepare(
      `INSERT INTO meta (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE meta.value IS ?3`,
    )
      .bind(LAST_SENT_KEY, now.toISOString(), last ? lastAt : null)
      .run();
    if (!claim.meta.changes) return;
    const total =
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM uploads WHERE status = 'pending'").first<{ n: number }>())?.n ?? rows.length;
    const fresh = rows.filter((r) => r.created_at > lastAt).length;
    await env.MAILER.send({
      from: { name: `${env.SITE_NAME} uploads`, email: env.CONTACT_FROM },
      to: env.CONTACT_TO,
      subject: `[${env.SITE_NAME}] ${total} upload${total === 1 ? "" : "s"} waiting for review`,
      text: [
        `${total} upload${total === 1 ? "" : "s"} couldn't be verified automatically and ${total === 1 ? "is" : "are"} waiting for review` +
          (lastAt ? ` (${fresh >= rows.length ? `${fresh}+` : fresh} new since the last email).` : "."),
        "",
        ...rows.map((r) => `- ${r.paper_id}: ${r.title ?? "(unknown paper)"}`),
        ...(total > rows.length ? [`- ... and ${total - rows.length} more`] : []),
        "",
        `Review them (view each PDF, then approve or reject): ${origin}/review`,
        "",
        `You'll get at most one of these emails every ${REVIEW_EMAIL_EVERY / 60000} minutes.`,
      ].join("\n"),
    });
  } catch (e) {
    console.error("review email failed", e instanceof Error ? e.message : String(e));
  }
}
