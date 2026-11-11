import { type Env } from "./db";

// Layer-1 abuse checks for anonymous PDF uploads (run before anything is stored).
// Limits are generous enough for one person to upload a batch of papers in one sitting.
export interface Limits { perIpPerDay: number; globalPerDay: number; globalBytesPerDay: number }

/** Upload form (people). Per-minute limit: UPLOAD_LIMITER binding (wrangler.jsonc). */
export const LIMITS: Limits = { perIpPerDay: 1000, globalPerDay: 20000, globalBytesPerDay: 20 * 1024 ** 3 };
/** Upload API (agents): most files are auto-verified, so limits can be high; unverified ones are
 *  capped separately (REVIEW_QUEUE). Per-minute limit: API_UPLOAD_LIMITER binding. */
export const API_LIMITS: Limits = { perIpPerDay: 5000, globalPerDay: 20000, globalBytesPerDay: 20 * 1024 ** 3 };
/** API uploads that land in the review queue: per IP per day, and pending in total (all sources). */
export const REVIEW_QUEUE = { perIpPerDay: 300, pendingTotal: 3000 };

/** Returns a reason if an API upload can't be queued for review right now, else null. */
export async function reviewQueueFull(env: Env, ip: string): Promise<string | null> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const r = await env.DB.prepare(
    `SELECT SUM(status = 'pending') AS pending,
            SUM(ip_hash = ?2 AND uploader = 'api' AND created_at > ?1 AND checks NOT LIKE '%"ok":true%') AS mine
       FROM uploads WHERE status = 'pending' OR (ip_hash = ?2 AND created_at > ?1)`,
  )
    .bind(since, ip)
    .first<{ pending: number | null; mine: number | null }>();
  if ((r?.mine ?? 0) >= REVIEW_QUEUE.perIpPerDay)
    return "You've sent many PDFs today that need a person to review them. Please wait for those to be reviewed and try again tomorrow.";
  if ((r?.pending ?? 0) >= REVIEW_QUEUE.pendingTotal)
    return "The review queue is full right now. Please try again in a few days.";
  return null;
}

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Salted hash of the client IP, so abuse can be throttled without storing raw IPs. */
export async function ipHash(env: Env, req: Request): Promise<string> {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const salt = env.TURNSTILE_SECRET ?? "local-dev";
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|${ip}`));
  return toHex(d).slice(0, 32);
}

/** Returns a user-facing reason if this client or the site as a whole is over its upload budget. */
export async function overLimit(
  env: Env,
  ip: string,
  limits: Limits = LIMITS,
  limiter: RateLimit | undefined = env.UPLOAD_LIMITER,
): Promise<string | null> {
  if (limiter) {
    const { success } = await limiter.limit({ key: ip });
    if (!success) return "Too many uploads in the last minute. Please wait a minute and try again.";
  }
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes,
            SUM(CASE WHEN ip_hash = ?2 THEN 1 ELSE 0 END) AS mine
       FROM uploads WHERE created_at > ?1`,
  )
    .bind(since, ip)
    .first<{ n: number; bytes: number; mine: number }>();
  if ((r?.mine ?? 0) >= limits.perIpPerDay) return "You’ve reached today’s upload limit. Thank you! Please try again tomorrow.";
  if ((r?.n ?? 0) >= limits.globalPerDay || (r?.bytes ?? 0) >= limits.globalBytesPerDay)
    return "The site has received the maximum number of uploads for today. Please try again tomorrow.";
  return null;
}

/** Structural sanity scan of an uploaded PDF. Returns a reason to reject (truncated file), or null.
 *  Active content is not a rejection: see activeContentScan(), which flags the upload for review.
 *  Heuristic first filter on the raw bytes. Names inside compressed object streams aren't
 *  visible here; verifyPdf (verify.ts) checks the parsed document for scripts and attachments. */
export function scanPdf(buf: ArrayBuffer): string | null {
  const bytes = new Uint8Array(buf);
  const tail = new TextDecoder("latin1").decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
  if (!tail.includes("%%EOF")) return "That PDF looks truncated (no end-of-file marker).";
  return null;
}

/** Returns a short description if the PDF's raw bytes carry active content (scripts, attachments,
 *  launch actions…), else null. Such uploads are queued for human review, never auto-published. */
export function activeContentScan(buf: ArrayBuffer): string | null {
  const bytes = new Uint8Array(buf);
  // Scan the raw bytes as latin1 for active-content features we never need for a paper.
  // PDF names may spell characters as #xx (/J#61vaScript), so decode those inside names first.
  const text = new TextDecoder("latin1")
    .decode(bytes)
    .replace(NAME_WITH_ESCAPE, (name) => name.replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))));
  const hit = ACTIVE.find((a) => a.re.test(text));
  return hit ? hit.label : null;
}

/** A PDF name token (up to the next delimiter or whitespace) containing at least one #xx escape. */
const NAME_WITH_ESCAPE = /\/[^\s\/<>\[\]()%{}]*#[0-9A-Fa-f]{2}[^\s\/<>\[\]()%{}]*/g;
const ACTIVE = [
  { re: /\/JavaScript\b/, label: "JavaScript" },
  { re: /\/JS\s*[(<\[]/, label: "JavaScript" },
  { re: /\/JS\s+\d+\s+\d+\s+R\b/, label: "JavaScript" },
  { re: /\/Launch\b/, label: "launch action" },
  { re: /\/EmbeddedFiles?\b/, label: "embedded files" },
  { re: /\/RichMedia\b/, label: "rich media" },
  { re: /\/XFA\b/, label: "XFA form" },
];
