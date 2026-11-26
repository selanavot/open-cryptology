// The agent API for original manuscripts (docs: llms.txt, "Posting original manuscripts").
// People never make or paste keys: an agent asks to connect (OAuth device flow), the person clicks
// Approve, and the agent collects a bearer token. Like a browser login, a token is short-lived
// (TOKEN_TTL_HOURS from approval, or until the person logs out) and there's nothing to manage:
// when it ends, the agent connects again. Tables: the "agent API" section of db/schema.sql. Only a token's SHA-256 is
// stored, and it's minted when the agent collects it. A token can post and read manuscripts, and
// post and edit comments (comments.ts), as that person, nothing else: it can't change the account
// or remove anything.
import type { Env } from "./db";
import { html, type Html } from "./html";
import { messagePage, page } from "./layout";
import { authOrigin, currentUser, randomId, randomToken, redirect303, sameOrigin, sha256hex, loadUser, type User } from "./auth";
import { latestManuscriptsJson, manuscriptJson, MAX_PDF, publishManuscript, type AuthorIn } from "./manuscripts";
import { siteOrigin } from "./seo";
import { avatar } from "./account";

const TOKEN_PREFIX = "oct_";
/** What a new token can do. Tokens minted before comments existed carry only "manuscripts". */
const SCOPES = "manuscripts comments";
export type Scope = "manuscripts" | "comments";
/** How long a token works after the person approves it. Then the agent connects again (one click). */
export const TOKEN_TTL_HOURS = 24;
const DAY_MS = 86_400_000;
export const LICENSE_ID = "CC-BY-4.0";

const nowIso = () => new Date().toISOString();

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", ...headers },
  });
}
export const err = (status: number, error: string, message: string, headers: Record<string, string> = {}) => json({ error, message }, status, headers);
const CONNECT_AGAIN = "For a bot account, ask a maintainer for a new key. For a personal agent, connect again (POST /api/oauth/device).";
const unauthorized = (error: string, message: string) => err(401, error, message, { "www-authenticate": `Bearer error="invalid_token"` });

// ---------------------------------------------------------------------------------------------
// tokens

interface TokenRow {
  id: string;
  user_id: string;
  scopes: string;
  expires_at: string;
}

/** Prepare the insert so a bot key can be replaced atomically with its predecessor. */
async function prepareToken(env: Env, userId: string, scopes: string, keepExpiry?: string) {
  const token = TOKEN_PREFIX + randomToken(32);
  const id = randomId(16);
  const now = new Date();
  const expires = keepExpiry ?? new Date(now.getTime() + TOKEN_TTL_HOURS * 3600_000).toISOString();
  const insert = env.DB.prepare("INSERT INTO api_tokens (id, hash, user_id, scopes, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(id, await sha256hex(token), userId, scopes, now.toISOString(), expires);
  return { insert, key: { id, token, expires } };
}

async function mintToken(env: Env, userId: string, keepExpiry?: string) {
  const { insert, key } = await prepareToken(env, userId, SCOPES, keepExpiry);
  await insert.run();
  return key;
}

/** Called for a registered bot after checking the maintainer session. */
export async function replaceBotKey(env: Env, userId: string) {
  const { insert, key } = await prepareToken(env, userId, "comments");
  await env.DB.batch([revokeBotKeys(env, userId), insert]);
  return key;
}

export function revokeBotKeys(env: Env, userId: string) {
  return env.DB.prepare("UPDATE api_tokens SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL")
    .bind(userId, nowIso());
}

/** The person and token behind `Authorization: Bearer oct_...`, or an error response. Never
 *  falls back to the session cookie. */
export async function tokenActor(env: Env, req: Request, origin: string, scope: Scope | null): Promise<{ user: User; token: TokenRow } | Response> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return unauthorized("no_token", `Send "Authorization: Bearer ${TOKEN_PREFIX}...". To get a token, connect first: see ${origin}/llms.txt.`);
  if (!m[1].startsWith(TOKEN_PREFIX)) return unauthorized("bad_token", "That isn't an Open Cryptology token.");
  const t = await env.DB.prepare("SELECT id, user_id, scopes, expires_at FROM api_tokens WHERE hash = ?1 AND revoked_at IS NULL")
    .bind(await sha256hex(m[1]))
    .first<TokenRow>();
  if (!t) return unauthorized("token_revoked", `That token is unknown or was revoked. ${CONNECT_AGAIN}`);
  if (Date.parse(t.expires_at) < Date.now()) return unauthorized("token_expired", `Tokens last ${TOKEN_TTL_HOURS} hours, and this one expired. ${CONNECT_AGAIN}`);
  if (scope && !t.scopes.split(" ").includes(scope)) return err(403, "scope", `This token can't ${scope === "comments" ? "post comments" : "post manuscripts"}.`);
  // loadUser refuses deleted accounts; merges move tokens to the kept account (auth.ts).
  const user = await loadUser(env, t.user_id);
  if (!user) return unauthorized("token_revoked", "The account behind this token is gone.");
  if (user.suspended) return err(403, "suspended", "This account is suspended.");
  return { user, token: t };
}

/** Maintainers: if an agent posted this manuscript, disconnect all of the uploader's agents (every
 *  live token of that account; their device codes can't mint new ones either, see reissue). */
export async function revokeAgentsOfManuscript(env: Env, manuscriptId: string): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE api_tokens SET revoked_at = ?2 WHERE revoked_at IS NULL
       AND user_id = (SELECT uploader_id FROM manuscripts WHERE id = ?1)
       AND EXISTS (SELECT 1 FROM manuscript_tokens WHERE manuscript_id = ?1)`,
  )
    .bind(manuscriptId, nowIso())
    .run();
  return (r.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------------------------
// posting and reading manuscripts

interface Metadata {
  title: string;
  authors: (string | AuthorIn)[];
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
    const isAuthor = (a: unknown) =>
      typeof a === "string" ||
      (!!a && typeof a === "object" && !Array.isArray(a) &&
        Object.entries(a).every(([k, v]) => ["name", "orcid", "email"].includes(k) && (typeof v === "string" || (k !== "name" && v == null))));
    if (!Array.isArray(authors) || !authors.every(isAuthor))
      return 'metadata.authors must be an array of names or {"name", "orcid", "email"} objects, in citation order.';
    return { title: String(o.title ?? ""), authors, abstract: String(o.abstract ?? ""), license: String(o.license ?? "") };
  }
  return {
    title: field("title"),
    authors: [...form.getAll("authors"), ...form.getAll("author")].filter((a): a is string => typeof a === "string"),
    abstract: field("abstract"),
    license: field("license"),
  };
}

/** POST /api/manuscripts. Checks the token, the rate and the size before reading the body. */
async function postManuscript(env: Env, req: Request, origin: string): Promise<Response> {
  const who = await tokenActor(env, req, origin, "manuscripts");
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
  path === "/api/manuscripts" ||
  API_MS_RE.test(path) ||
  path === "/api/oauth/device" ||
  path === "/api/oauth/token" ||
  path === "/connect" ||
  (path === "/api/me" && hasBearer(req));

export async function handleAgentApi(req: Request, env: Env, url: URL): Promise<Response> {
  try {
    return await routeAgentApi(req, env, url);
  } catch (e) {
    if (url.pathname === "/connect") throw e; // a page: the site's usual error page
    console.error("agent API", url.pathname, e);
    return err(500, "server_error", "Something went wrong on our side. Try again in a minute; if it keeps happening, tell the person.");
  }
}

async function routeAgentApi(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const origin = siteOrigin(env, url);
  const isGet = req.method === "GET" || req.method === "HEAD";
  const pub = { "cache-control": "public, max-age=60", "access-control-allow-origin": "*" };
  if (path === "/connect") {
    if (!isGet && req.method !== "POST") return messagePage(env, 405, "Method not allowed", html`<p>Use the buttons on this page.</p>`, { cache: "no-store", noindex: true });
    return connectRoute(env, req, url);
  }
  if (path === "/api/oauth/device" || path === "/api/oauth/token") {
    if (req.method !== "POST") return err(405, "method_not_allowed", "Use POST.");
    const net = await networkHash(env, req);
    const limited = await env.CONNECT_LIMITER?.limit({ key: `${path}|${net}` });
    if (limited && !limited.success) return oauthErr(path === "/api/oauth/device" ? 429 : 400, "slow_down", "Too many requests from your network. Wait a minute, then try again.");
    return path === "/api/oauth/device" ? startConnect(env, req, net, authOrigin(env, url)) : collectToken(env, req, origin);
  }
  if (path === "/api/me") {
    if (!isGet) return err(405, "method_not_allowed", "Use GET.");
    const who = await tokenActor(env, req, origin, null);
    if (who instanceof Response) return who;
    return json({
      user: { displayName: who.user.displayName, profile_url: `${origin}/u/${who.user.id}` },
      can: [
        ...(who.token.scopes.split(" ").includes("manuscripts") ? ["post manuscripts", "read manuscripts"] : []),
        ...(who.token.scopes.split(" ").includes("comments") ? ["post comments", "edit its person's comments"] : []),
      ],
      expires_at: who.token.expires_at,
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

// ---------------------------------------------------------------------------------------------
// connecting an agent: the OAuth 2.0 device authorization grant (RFC 8628), one click to approve
//   agent:  POST /api/oauth/device                -> device_code, verification_uri_complete, ...
//   person: opens /connect?code=WXYZ-2345, logged in, clicks Approve
//   agent:  POST /api/oauth/token {grant_type, device_code} -> access_token (once)

const CONNECT_TTL_MS = 15 * 60_000;
const POLL_INTERVAL_S = 5;
/** Requests still waiting for approval, per network and on the whole site. */
const OPEN_CONNECTS_PER_NETWORK = 10;
const OPEN_CONNECTS_SITE = 1000;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** No vowels (no accidental words) and no 0/1/O/I look-alikes. */
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";

/** 8 letters, uniform over the alphabet: bytes past the last whole multiple of its length are skipped. */
function newUserCode(): string {
  const n = CODE_ALPHABET.length, cut = 256 - (256 % n);
  let code = "";
  while (code.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) if (b < cut && code.length < 8) code += CODE_ALPHABET[b % n];
  }
  return code;
}
const showCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;
const normCode = (s: string | null) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);

/** The client's network: its IPv4 address, or the /64 of an IPv6 one (one host often holds a whole /64). */
function network(req: Request): string {
  const ip = (req.headers.get("cf-connecting-ip") ?? "unknown").toLowerCase();
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
const networkHash = async (env: Env, req: Request) => (await sha256hex(`${env.TURNSTILE_SECRET ?? "local-dev"}|${network(req)}`)).slice(0, 32);

/** OAuth-style error: {error, error_description}, plus `message` like the rest of this API. */
const oauthErr = (status: number, error: string, description: string) =>
  json({ error, error_description: description, message: description }, status);

/** A request body as fields: JSON, form-urlencoded or multipart. */
async function bodyFields(req: Request): Promise<Record<string, string>> {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  try {
    if (type.includes("application/json")) {
      const o = (await req.json()) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : ""]));
    }
    if (type.includes("form")) {
      const f = await req.formData();
      return Object.fromEntries([...f.entries()].filter(([, v]) => typeof v === "string") as [string, string][]);
    }
  } catch {
    /* fall through */
  }
  return {};
}

interface ConnectRow {
  id: string;
  user_code: string;
  country: string | null;
  created_at: string;
  expires_at: string;
  status: "pending" | "approved" | "denied" | "claimed";
  user_id: string | null;
}

/** POST /api/oauth/device: an agent asks to connect. */
async function startConnect(env: Env, req: Request, ip: string, loginOrigin: string): Promise<Response> {
  const now = new Date();
  const recent = new Date(now.getTime() - CONNECT_TTL_MS).toISOString();
  const [, mine, all] = await env.DB.batch([
    env.DB.prepare("DELETE FROM agent_connect WHERE created_at < ?1").bind(new Date(now.getTime() - DAY_MS).toISOString()),
    env.DB.prepare("SELECT count(*) AS n FROM agent_connect WHERE ip_hash = ?1 AND created_at > ?2 AND status = 'pending'").bind(ip, recent),
    env.DB.prepare("SELECT count(*) AS n FROM agent_connect WHERE created_at > ?1 AND status = 'pending'").bind(recent),
  ]);
  const count = (r: D1Result) => (r.results[0] as { n: number } | undefined)?.n ?? 0;
  if (count(mine) >= OPEN_CONNECTS_PER_NETWORK)
    return oauthErr(429, "slow_down", "Too many connect requests from here are waiting for approval. Use a link you already have, or try again in 15 minutes.");
  if (count(all) >= OPEN_CONNECTS_SITE)
    return oauthErr(503, "temporarily_unavailable", "Too many connect requests are waiting right now. Try again in a few minutes.");
  const deviceCode = randomToken(32);
  const country = (req as Request & { cf?: { country?: string } }).cf?.country ?? null;
  const expires = new Date(now.getTime() + CONNECT_TTL_MS).toISOString();
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = newUserCode();
    const ok = await env.DB.prepare(
      `INSERT OR IGNORE INTO agent_connect (id, user_code, ip_hash, country, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(await sha256hex(deviceCode), code, ip, country, now.toISOString(), expires)
      .run();
    if (!ok.meta.changes) continue;
    const link = `${loginOrigin}/connect?code=${showCode(code)}`;
    return json({
      device_code: deviceCode,
      user_code: showCode(code),
      verification_uri: `${loginOrigin}/connect`,
      verification_uri_complete: link,
      expires_in: CONNECT_TTL_MS / 1000,
      interval: POLL_INTERVAL_S,
      message: `Ask the person to open ${link}, check that it shows the code ${showCode(code)}, and click Approve (it expires in 15 minutes). Then POST /api/oauth/token with grant_type=${DEVICE_GRANT} and this device_code.`,
    });
  }
  return oauthErr(503, "temporarily_unavailable", "Please try again.");
}

/** POST /api/oauth/token: the agent collects its token once the person approved. */
async function collectToken(env: Env, req: Request, origin: string): Promise<Response> {
  const f = await bodyFields(req);
  if (f.grant_type && f.grant_type !== DEVICE_GRANT) return oauthErr(400, "unsupported_grant_type", `Use grant_type=${DEVICE_GRANT}.`);
  if (!f.device_code) return oauthErr(400, "invalid_request", "Send the device_code from POST /api/oauth/device.");
  const id = await sha256hex(f.device_code);
  const row = await env.DB.prepare("SELECT status, expires_at, user_id, token_id FROM agent_connect WHERE id = ?1")
    .bind(id)
    .first<Pick<ConnectRow, "status" | "expires_at" | "user_id"> & { token_id: string | null }>();
  const startOver = "Start over with POST /api/oauth/device.";
  if (!row) return oauthErr(400, "expired_token", `Unknown or expired device_code. ${startOver}`);
  if (row.status === "denied") return oauthErr(400, "access_denied", "The person declined.");
  if (Date.parse(row.expires_at) < Date.now()) {
    const why = {
      pending: "The link expired before it was approved.",
      approved: "It was approved more than 15 minutes ago and never collected.",
      claimed: "A lost token can be collected again only within 15 minutes of approval.",
    }[row.status];
    return oauthErr(400, "expired_token", `${why} ${startOver}`);
  }
  if (row.status === "claimed") return reissue(env, origin, id, row);
  if (row.status === "pending")
    return oauthErr(400, "authorization_pending", `Waiting for the person to approve. Ask again in ${POLL_INTERVAL_S} seconds, or once they say they approved.`);
  // Approved: mint the token, then claim the request with it in one statement, so a device_code
  // yields one token and a later re-collect always finds (and revokes) the token it replaces.
  const user = row.user_id ? await loadUser(env, row.user_id) : null;
  if (!user) return oauthErr(400, "access_denied", "The account that approved this is gone.");
  const t = await mintToken(env, user.id);
  const claimed = await env.DB.prepare(
    "UPDATE agent_connect SET status = 'claimed', token_id = ?3 WHERE id = ?1 AND status = 'approved' AND user_id = ?4 AND expires_at > ?2",
  )
    .bind(id, nowIso(), t.id, user.id)
    .run();
  if (!claimed.meta.changes) {
    await revokeToken(env, t.id);
    return oauthErr(409, "temporarily_unavailable", "Another request just collected a token with this device_code. Try again.");
  }
  return tokenJson(origin, user, t);
}

/** The agent lost its token: within the 15 minutes, the same device_code gets a new one and the
 *  old one stops working, so the person doesn't approve twice and no lost token stays active. */
async function reissue(env: Env, origin: string, id: string, row: { user_id: string | null; token_id: string | null }): Promise<Response> {
  const user = row.user_id ? await loadUser(env, row.user_id) : null;
  if (!user) return oauthErr(400, "access_denied", "The account that approved this is gone.");
  // The token being replaced is the live one (a re-collect swaps it in before revoking the old);
  // if it was revoked, a maintainer or the account cut this connection off.
  const current = row.token_id
    ? await env.DB.prepare("SELECT revoked_at, expires_at FROM api_tokens WHERE id = ?1").bind(row.token_id).first<{ revoked_at: string | null; expires_at: string }>()
    : null;
  if (!current || current.revoked_at) return oauthErr(400, "access_denied", "This connection was cut off.");
  const t = await mintToken(env, user.id, current.expires_at);
  const r = await env.DB.prepare("UPDATE agent_connect SET token_id = ?2 WHERE id = ?1 AND status = 'claimed' AND token_id IS ?3").bind(id, t.id, row.token_id).run();
  if (!r.meta.changes) {
    await revokeToken(env, t.id);
    return oauthErr(409, "temporarily_unavailable", "Another request just collected a token with this device_code. Try again.");
  }
  await revokeToken(env, row.token_id!);
  return tokenJson(origin, user, t);
}

const revokeToken = (env: Env, id: string) =>
  env.DB.prepare("UPDATE api_tokens SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL").bind(id, nowIso()).run();

function tokenJson(origin: string, user: User, t: { token: string; expires: string }): Response {
  return json({
    access_token: t.token,
    token_type: "Bearer",
    expires_in: TOKEN_TTL_HOURS * 3600,
    expires_at: t.expires,
    scope: SCOPES,
    user: { displayName: user.displayName, profile_url: `${origin}/u/${user.id}` },
    note: `Store this token and reuse it until expires_at; then connect again. Tell the person which account you're connected as (user.displayName). If you lose the token within 15 minutes of approval, POST the same device_code again for a new one (the old one stops working).`,
  });
}

const agoText = (iso: string) => {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return min < 1 ? "just now" : min === 1 ? "1 minute ago" : `${min} minutes ago`;
};
function countryName(cc: string | null): string | null {
  if (!cc || cc === "XX" || cc === "T1") return null;
  let name = cc;
  try {
    name = new Intl.DisplayNames(["en"], { type: "region" }).of(cc) ?? cc;
  } catch {
    /* keep the code */
  }
  return name;
}

/** /connect pages: a small centred card, like the log-in page. */
function connectPage(env: Env, title: string, body: Html, status = 200): Response {
  return page(env, {
    title,
    status,
    cache: "no-store",
    noindex: true,
    body: html`<div class="settings"><section class="settings-card settings-login connect-card">${body}</section></div>`,
  });
}

const done = (env: Env, title: string, heading: string, status = 200) =>
  connectPage(env, title, html`<h1 class="settings-title">${heading}</h1><p class="settings-hint">You can close this tab.</p>`, status);

/** /connect without a code: for agents that show the verification_uri and the code separately. */
const codeForm = (env: Env, typed: string) =>
  connectPage(
    env,
    "Connect an agent",
    html`<h1 class="settings-title">Connect an agent</h1>
  <form method="get" action="/connect" class="connect-buttons">
    <input class="form-control connect-input${typed ? " is-invalid" : ""}" name="code" value="${typed}" placeholder="WXYZ-2345" aria-label="The code your agent gave you" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" required autofocus>
    <button class="btn hm-primary" type="submit">Continue</button>
  </form>`,
    typed ? 400 : 200,
  );

/** GET /connect?code=...: the approve page (log in first). POST /connect: approve or deny. */
async function connectRoute(env: Env, req: Request, url: URL): Promise<Response> {
  const isPost = req.method === "POST";
  if (isPost && !sameOrigin(req, env)) return messagePage(env, 403, "Rejected", html`<p>Cross-site requests aren’t accepted.</p>`, { cache: "no-store", noindex: true });
  const form = isPost ? await req.formData().catch(() => null) : null;
  const code = normCode(isPost ? (form?.get("code")?.toString() ?? "") : url.searchParams.get("code"));
  const a = await currentUser(env, req);
  if (!a) return redirect303(`/account?next=${encodeURIComponent(code ? `/connect?code=${showCode(code)}` : "/connect")}`);
  const gone = () =>
    connectPage(env, "Link expired", html`<h1 class="settings-title">This link expired</h1><p class="settings-hint">Ask your agent for a new one.</p>`, 410);
  if (!isPost && code.length !== 8) return codeForm(env, (url.searchParams.get("code") ?? "").slice(0, 12));
  if (code.length !== 8) return gone();
  const row = await env.DB.prepare("SELECT * FROM agent_connect WHERE user_code = ?1").bind(code).first<ConnectRow>();
  if (!row || Date.parse(row.expires_at) < Date.now() || row.status === "claimed" || row.status === "denied") return gone();

  if (isPost) {
    const decision = form?.get("decision") === "approve" ? "approved" : "denied";
    // Approving gives the agent 15 minutes from now to collect its token, however long the
    // person took (it may wait to be told rather than poll).
    const now = Date.now();
    const r = await env.DB.prepare(
      `UPDATE agent_connect SET status = ?2, user_id = ?3,
         expires_at = CASE WHEN ?2 = 'approved' AND expires_at < ?5 THEN ?5 ELSE expires_at END
       WHERE id = ?1 AND status = 'pending' AND expires_at > ?4`,
    )
      .bind(row.id, decision, a.user.id, new Date(now).toISOString(), new Date(now + CONNECT_TTL_MS).toISOString())
      .run();
    if (!r.meta.changes) return gone();
    return decision === "approved" ? done(env, "Agent connected", "Connected") : done(env, "Declined", "Declined");
  }
  if (row.status === "approved") return done(env, "Already approved", "Already approved");
  const where = countryName(row.country);
  return connectPage(
    env,
    "Connect an agent?",
    html`<h1 class="settings-title">Connect an agent?</h1>
  <div class="connect-who">${avatar(a.user, "avatar-xs")}<span>${a.user.displayName}</span></div>
  <div class="connect-code">${showCode(row.user_code)}</div>
  <p class="connect-from">${where ? `${where} · ` : ""}${agoText(row.created_at)}</p>
  <form method="post" action="/connect" class="connect-buttons">
    <input type="hidden" name="code" value="${showCode(row.user_code)}">
    <button class="btn hm-primary" type="submit" name="decision" value="approve">Approve</button>
    <button class="btn btn-outline-dark" type="submit" name="decision" value="deny">Deny</button>
  </form>
  <p class="settings-fine">It can post manuscripts as you, under <a href="/terms">CC BY 4.0</a>, and post and edit comments as you, for ${TOKEN_TTL_HOURS} hours or until you log out.</p>`,
  );
}
