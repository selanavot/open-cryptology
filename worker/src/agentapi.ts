// The agent API for original manuscripts (docs: llms.txt, "Posting original manuscripts").
// An agent posts as one person with a bearer token the person makes on their account page and
// gives to the agent. Tables: the "agent API" section of db/schema.sql. Only a token's SHA-256 is
// stored; the secret is shown once. A token can post and read manuscripts as that person, nothing
// else: it can't change the account or remove anything.
// (An approve-in-the-browser device flow may come later; it was left out of the first version
// because of phishing: a link to approve someone else's agent.)
import type { Env } from "./db";
import { randomId, randomToken, sha256hex, loadUser, type User } from "./auth";
import { latestManuscriptsJson, manuscriptJson, MAX_PDF, publishManuscript } from "./manuscripts";
import { siteOrigin } from "./seo";

const TOKEN_PREFIX = "oct_";
const SCOPE = "manuscripts";
export const LABEL_MAX = 80;
/** A token nobody used for this long stops working (the account page shows it as expired). */
export const TOKEN_IDLE_DAYS = 90;
const TOUCH_MS = 3600_000;
const DAY_MS = 86_400_000;
export const LICENSE_ID = "CC-BY-4.0";

const nowIso = () => new Date().toISOString();

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", ...headers },
  });
}
const err = (status: number, error: string, message: string, headers: Record<string, string> = {}) => json({ error, message }, status, headers);
const unauthorized = (error: string, message: string) => err(401, error, message, { "www-authenticate": `Bearer error="invalid_token"` });

export const cleanLabel = (s: unknown) =>
  String(s ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX);

// ---------------------------------------------------------------------------------------------
// tokens

export interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  last_used: string | null;
}

/** When a token stops working if nobody uses it. */
export const tokenExpires = (t: Pick<TokenRow, "created_at" | "last_used">) =>
  new Date(Date.parse(t.last_used ?? t.created_at) + TOKEN_IDLE_DAYS * DAY_MS);

/** A new token for `userId`; returns the secret (shown once) and its id. */
export async function mintToken(env: Env, userId: string, name: string): Promise<{ id: string; token: string }> {
  const token = TOKEN_PREFIX + randomToken(32);
  const id = randomId(16);
  await env.DB.prepare("INSERT INTO api_tokens (id, hash, user_id, name, scopes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(id, await sha256hex(token), userId, name, SCOPE, nowIso())
    .run();
  return { id, token };
}

/** The person and token behind `Authorization: Bearer oc_...`, or an error response. Never falls
 *  back to the session cookie. */
export async function tokenActor(env: Env, req: Request, origin: string): Promise<{ user: User; token: TokenRow } | Response> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  if (!m)
    return unauthorized("no_token", `Send "Authorization: Bearer ${TOKEN_PREFIX}...". The person you post for makes a token at ${origin}/account (Agents).`);
  if (!m[1].startsWith(TOKEN_PREFIX)) return unauthorized("bad_token", "That isn't an Open Cryptology token.");
  const t = await env.DB.prepare("SELECT id, user_id, name, scopes, created_at, last_used FROM api_tokens WHERE hash = ?1 AND revoked_at IS NULL")
    .bind(await sha256hex(m[1]))
    .first<TokenRow & { scopes: string }>();
  if (!t) return unauthorized("token_revoked", `That token is unknown or was disconnected. Ask the person for a new one (${origin}/account).`);
  if (!t.scopes.split(" ").includes(SCOPE)) return err(403, "scope", "This token can't post manuscripts. Ask the person for a new one.");
  if (tokenExpires(t).getTime() < Date.now())
    return unauthorized("token_expired", `That token went unused for ${TOKEN_IDLE_DAYS} days and expired. Ask the person for a new one (${origin}/account).`);
  // loadUser refuses deleted accounts; merges move tokens to the kept account (auth.ts).
  const user = await loadUser(env, t.user_id);
  if (!user) return unauthorized("token_revoked", "The account behind this token is gone.");
  if (!t.last_used || Date.now() - Date.parse(t.last_used) > TOUCH_MS)
    await env.DB.prepare("UPDATE api_tokens SET last_used = ?2 WHERE id = ?1").bind(t.id, nowIso()).run();
  return { user, token: t };
}

export async function tokensOf(env: Env, userId: string): Promise<TokenRow[]> {
  const r = await env.DB.prepare(
    "SELECT id, user_id, name, created_at, last_used FROM api_tokens WHERE user_id = ?1 AND revoked_at IS NULL ORDER BY created_at DESC",
  )
    .bind(userId)
    .all<TokenRow>();
  return r.results;
}

export async function revokeToken(env: Env, userId: string, tokenId: string): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE api_tokens SET revoked_at = ?3 WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL")
    .bind(tokenId, userId, nowIso())
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** Maintainers: disconnect the agent that posted a manuscript (if one did). */
export async function revokeTokenOfManuscript(env: Env, manuscriptId: string): Promise<boolean> {
  const r = await env.DB.prepare(
    "UPDATE api_tokens SET revoked_at = ?2 WHERE revoked_at IS NULL AND id = (SELECT token_id FROM manuscript_tokens WHERE manuscript_id = ?1)",
  )
    .bind(manuscriptId, nowIso())
    .run();
  return (r.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------------------------
// posting and reading manuscripts

interface Metadata {
  title: string;
  authors: string[];
  abstract: string;
  license: string;
}

/** The metadata of a post: one `metadata` part (JSON, as a field or a small file), or separate
 *  title / author / abstract / license fields. Returns an error message for a malformed part. */
async function readMetadata(form: FormData): Promise<Metadata | string> {
  const field = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  const raw = form.get("metadata");
  if (raw !== null) {
    let m: unknown;
    try {
      m = JSON.parse(typeof raw === "string" ? raw : raw.size <= 64 * 1024 ? await raw.text() : "");
    } catch {
      return 'metadata must be JSON: {"title": "...", "authors": ["..."], "abstract": "...", "license": "CC-BY-4.0"}.';
    }
    const o = (m ?? {}) as Record<string, unknown>;
    const authors = o.authors;
    if (!Array.isArray(authors) || !authors.every((a) => typeof a === "string")) return "metadata.authors must be an array of names, in citation order.";
    return { title: String(o.title ?? ""), authors, abstract: String(o.abstract ?? ""), license: String(o.license ?? "") };
  }
  return {
    title: field("title"),
    authors: form.getAll("author").filter((a): a is string => typeof a === "string"),
    abstract: field("abstract"),
    license: field("license"),
  };
}

/** POST /api/manuscripts. Checks the token, the rate and the size before reading the body. */
async function postManuscript(env: Env, req: Request, origin: string): Promise<Response> {
  const who = await tokenActor(env, req, origin);
  if (who instanceof Response) return who;
  if (env.API_UPLOAD_LIMITER) {
    const { success } = await env.API_UPLOAD_LIMITER.limit({ key: `tok:${who.token.id}` });
    if (!success) return err(429, "rate_limited", "Too many requests in the last minute. Wait a minute and try again.");
  }
  if (Number(req.headers.get("content-length") ?? "0") > MAX_PDF + 256 * 1024) return err(413, "too_large", "That file is over 30 MB.");
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data"))
    return err(415, "multipart_required", "Send multipart/form-data with two parts: file (the PDF) and metadata (JSON). See /llms.txt.");
  const form = await req.formData().catch(() => null);
  if (!form) return err(400, "bad_form", "That didn't parse as multipart/form-data.");
  const meta = await readMetadata(form);
  if (typeof meta === "string") return err(400, "bad_metadata", meta);
  const file = form.get("file") ?? form.get("pdf");
  const r = await publishManuscript(env, who.user.id, {
    title: meta.title,
    authors: meta.authors,
    abstract: meta.abstract,
    file: file instanceof File ? file : null,
    license: {
      accepted: meta.license.trim().toUpperCase() === LICENSE_ID,
      message: `Set "license": "${LICENSE_ID}". It confirms that the person you post for agrees to the terms (${origin}/terms) and licenses this manuscript under CC BY 4.0.`,
    },
    viaToken: who.token.id,
  });
  if (!r.ok) return json({ error: r.code, message: r.message, ...(r.existing ? { id: r.existing, url: `${origin}/${r.existing}` } : {}) }, r.status);
  const ms = await manuscriptJson(env, origin, r.id);
  return json({ ...ms, duplicate: r.duplicate }, r.duplicate ? 200 : 201, r.duplicate ? {} : { location: `${origin}/${r.id}` });
}

const API_MS_RE = /^\/api\/manuscripts\/(\d{4}-\d{2}-\d{2})\/(\d{1,4})\/?$/;
const hasBearer = (req: Request) => /^Bearer\s/i.test(req.headers.get("authorization") ?? "");

/** /api/manuscripts, /api/manuscripts/<day>/<n>, and /api/me when it carries a token (the
 *  cookie version of /api/me stays in auth.ts). */
export const isAgentApiPath = (path: string, req: Request): boolean =>
  path === "/api/manuscripts" || API_MS_RE.test(path) || (path === "/api/me" && hasBearer(req));

export async function handleAgentApi(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const origin = siteOrigin(env, url);
  const isGet = req.method === "GET" || req.method === "HEAD";
  const pub = { "cache-control": "public, max-age=60", "access-control-allow-origin": "*" };
  if (path === "/api/me") {
    if (!isGet) return err(405, "method_not_allowed", "Use GET.");
    const who = await tokenActor(env, req, origin);
    if (who instanceof Response) return who;
    const t = who.token;
    return json({
      user: { displayName: who.user.displayName, profile_url: `${origin}/u/${who.user.id}` },
      can: ["post manuscripts", "read manuscripts"],
      token: { name: t.name, created_at: t.created_at, expires_if_unused_until: tokenExpires({ ...t, last_used: nowIso() }).toISOString() },
    });
  }
  if (path === "/api/manuscripts") {
    if (req.method === "POST") return postManuscript(env, req, origin);
    if (!isGet) return err(405, "method_not_allowed", "GET lists the newest manuscripts; POST posts one.");
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    return json({ manuscripts: await latestManuscriptsJson(env, origin, limit) }, 200, pub);
  }
  const mm = API_MS_RE.exec(path)!;
  if (!isGet) return err(405, "method_not_allowed", "Use GET.");
  const ms = await manuscriptJson(env, origin, `${mm[1]}/${Number(mm[2])}`);
  if (!ms) return err(404, "not_found", "No such original manuscript.");
  if (ms.removed) return err(410, "removed", "This original manuscript was removed by the maintainers.");
  return json(ms, 200, pub);
}
