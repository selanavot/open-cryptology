import { type Env } from "./db";

// Layer-1 abuse checks for anonymous PDF uploads (run before anything is stored).
// Limits are generous enough for one person to upload a batch of papers in one sitting.
export const LIMITS = {
  perIpPerMinute: 30, // enforced by the UPLOAD_LIMITER rate-limit binding (wrangler.jsonc)
  perIpPerDay: 300,
  globalPerDay: 2000,
  globalBytesPerDay: 4 * 1024 ** 3,
};

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Salted hash of the client IP, so abuse can be throttled without storing raw IPs. */
export async function ipHash(env: Env, req: Request): Promise<string> {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const salt = env.TURNSTILE_SECRET ?? "local-dev";
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|${ip}`));
  return toHex(d).slice(0, 32);
}

/** Returns a user-facing reason if this client or the site as a whole is over its upload budget. */
export async function overLimit(env: Env, ip: string): Promise<string | null> {
  if (env.UPLOAD_LIMITER) {
    const { success } = await env.UPLOAD_LIMITER.limit({ key: ip });
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
  if ((r?.mine ?? 0) >= LIMITS.perIpPerDay) return "You’ve reached today’s upload limit. Thank you! Please try again tomorrow.";
  if ((r?.n ?? 0) >= LIMITS.globalPerDay || (r?.bytes ?? 0) >= LIMITS.globalBytesPerDay)
    return "The site has received the maximum number of uploads for today. Please try again tomorrow.";
  return null;
}

/** Structural sanity scan of an uploaded PDF. Returns a reason to reject, or null.
 *  Heuristic first filter on the raw bytes. Names inside compressed object streams aren't
 *  visible here; verifyPdf (verify.ts) checks the parsed document for scripts and attachments. */
export function scanPdf(buf: ArrayBuffer): string | null {
  const bytes = new Uint8Array(buf);
  const tail = new TextDecoder("latin1").decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
  if (!tail.includes("%%EOF")) return "That PDF looks truncated (no end-of-file marker).";
  // Scan the raw bytes as latin1 for active-content features we never need for a paper.
  // PDF names may spell characters as #xx (/J#61vaScript), so decode those inside names first.
  const text = new TextDecoder("latin1")
    .decode(bytes)
    .replace(NAME_WITH_ESCAPE, (name) => name.replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))));
  if (ACTIVE.some((re) => re.test(text))) return ACTIVE_MSG;
  return null;
}

/** A PDF name token (up to the next delimiter or whitespace) containing at least one #xx escape. */
const NAME_WITH_ESCAPE = /\/[^\s\/<>\[\]()%{}]*#[0-9A-Fa-f]{2}[^\s\/<>\[\]()%{}]*/g;
const ACTIVE = [/\/JavaScript\b/, /\/JS\s*[(<\[]/, /\/JS\s+\d+\s+\d+\s+R\b/, /\/Launch\b/, /\/EmbeddedFiles?\b/, /\/RichMedia\b/, /\/XFA\b/];
export const ACTIVE_MSG =
  "That PDF contains active content (scripts, embedded files or launch actions), which we don’t accept.";
