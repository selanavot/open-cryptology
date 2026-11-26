// Accounts: sign-in with GitHub, Google or ORCID, linking them into one account, and browser
// sessions; plus the helpers other features use to find out who is asking (design:
// docs/ACCOUNTS.md; tables: the "accounts" section of db/schema.sql). No passwords, and the
// providers' access tokens are dropped as soon as the profile is read.
//
// Sessions: the __Host-oc_session cookie holds 32 random bytes; D1 keeps only their SHA-256.
// Pages are publicly cached, so nothing signed-in is rendered into them: app.js reads the
// display-only oc_login cookie, and the session itself is looked up only on POSTs, /api/me and
// the no-store account page (currentUser / requireUser).
import type { Env } from "./db";
import { html } from "./html";
import { messagePage } from "./layout";
import { parseEmail } from "./orcid";

export type Role = "member" | "maintainer";

export interface Identity {
  provider: Provider;
  providerUserId: string; // GitHub numeric id / Google sub / ORCID iD
  handle: string; // GitHub login / Google email domain / ORCID iD
  url: string; // https://github.com/<login> | https://orcid.org/<iD> | "" (Google)
  name: string; // the person's name as the provider has it ("" when it has none)
  avatar: string; // profile photo URL (GitHub, Google), or ""
}
export interface User {
  id: string; // internal: never shown on a page
  displayName: string; // customName, else the name from ORCID, Google or GitHub (in that order)
  customName: string | null;
  botBio: string | null; // null for a personal account
  avatar: string; // photo from Google or GitHub, or "" (pages show initials)
  role: Role;
  identities: Identity[];
  suspended: boolean; // a maintainer suspended it (moderation.ts): it can't post, edit, vote or use agents
}
export interface Actor {
  user: User;
  sessionId: string; // hash of the session cookie
}
export type FailureCode = "signin" | "role" | "origin";
export interface AuthFailure {
  code: FailureCode;
  status: 401 | 403;
}

export const SESSION_COOKIE = "__Host-oc_session";
export const LOGIN_COOKIE = "oc_login"; // display only: URI-encoded JSON {n: name, a: photo URL}, never trusted
const OAUTH_COOKIE = "__Host-oc_oauth";
const SESSION_DAYS = 30; // sliding expiry, enforced in D1
const SESSION_MAX_DAYS = 180; // absolute limit: sign in again after this, however active
const COOKIE_MAX_AGE = 400 * 86400; // browsers cap cookies at 400 days; D1 decides validity
const TOUCH_MS = 3600_000; // refresh last_seen at most once an hour
const DAY_MS = 86400_000;

// ---------------------------------------------------------------------------------------------
// small helpers

const nowIso = () => new Date().toISOString();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export const randomToken = (n = 32): string => b64url(crypto.getRandomValues(new Uint8Array(n)));

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
/** Random lowercase base32 id (12 chars = 60 bits). */
export function randomId(len = 12): string {
  return [...crypto.getRandomValues(new Uint8Array(len))].map((b) => B32[b & 31]).join("");
}

export async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function cookies(req: Request): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) m.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return m;
}

/** The origin OAuth providers redirect back to. wrangler dev rewrites request URLs to the
 *  production host, so local runs set AUTH_ORIGIN=http://localhost:8788 in .dev.vars. */
export function authOrigin(env: Env, url: URL): string {
  return (env.AUTH_ORIGIN || url.origin).replace(/\/$/, "");
}

/** Only same-origin paths may be redirect targets ("/x", not "//host" or "/\host"). */
export function safeNext(n: string | null | undefined): string {
  if (!n || n.length > 500 || !n.startsWith("/") || n.startsWith("//") || n.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f\u007f]/.test(n)) return "/";
  return n;
}

/** CSRF check for cookie-authenticated non-GET requests: the browser's Origin (or, failing that,
 *  Sec-Fetch-Site) must say the request came from our own pages. */
export function sameOrigin(req: Request, env: Env): boolean {
  const url = new URL(req.url);
  const origin = req.headers.get("origin");
  if (origin) return origin === url.origin || origin === authOrigin(env, url);
  const site = req.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

const noStore = { "cache-control": "no-store", "x-robots-tag": "noindex" };

export function redirect303(location: string, setCookies: string[] = []): Response {
  const h = new Headers({ location, ...noStore });
  for (const c of setCookies) h.append("set-cookie", c);
  return new Response(null, { status: 303, headers: h });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", ...noStore },
  });
}

// ---------------------------------------------------------------------------------------------
// names and photos

export const DELETED_NAME = "deleted user";
export const NAME_MAX = 60;
export const cleanName = (s: string) => s.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();

/** The name a person goes by here comes from their sign-ins, in this order, unless they set their
 *  own. Names needn't be unique: many researchers share one. */
const NAME_ORDER: Provider[] = ["orcid", "google", "github"];
const PHOTO_ORDER: Provider[] = ["google", "github"];

function nameFrom(ids: Identity[]): string {
  for (const p of NAME_ORDER) {
    const i = ids.find((x) => x.provider === p && x.name);
    if (i) return i.name;
  }
  const gh = ids.find((x) => x.provider === "github");
  if (gh) return gh.handle;
  return ids.some((x) => x.provider === "orcid") ? "ORCID user" : "Google user";
}
const photoFrom = (ids: Identity[]): string => {
  for (const p of PHOTO_ORDER) {
    const i = ids.find((x) => x.provider === p && x.avatar);
    if (i) return i.avatar;
  }
  return "";
};

/** The name the log-in methods give, ignoring a custom name (for "Reset to …" on /account). */
export const nameFromIds = (u: User): string => nameFrom(u.identities);

/** Why a custom name can't be used, or null if it can. */
export function nameProblem(name: string): string | null {
  const n = cleanName(name);
  if (!n) return "Enter a name.";
  if ([...n].length > NAME_MAX) return `Names can be at most ${NAME_MAX} characters.`;
  return null;
}

/** Set a custom name, or (null) go back to the name from the sign-ins. */
export async function setCustomName(env: Env, userId: string, name: string | null): Promise<void> {
  await env.DB.prepare("UPDATE users SET custom_name = ?2 WHERE id = ?1").bind(userId, name === null ? null : cleanName(name)).run();
}

// ---------------------------------------------------------------------------------------------
// loading users

interface IdentityRow {
  provider: Provider;
  provider_user_id: string;
  user_id: string;
  handle: string;
  url: string;
  name: string | null;
  avatar: string | null;
}
const toIdentity = (r: IdentityRow): Identity => ({
  provider: r.provider,
  providerUserId: r.provider_user_id,
  handle: r.handle,
  url: r.url,
  name: r.name ?? "",
  avatar: r.avatar ?? "",
});

const maintainerIds = (env: Env): string[] =>
  (env.MAINTAINER_GITHUB_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Maintainer exactly while one of the sign-ins is a GitHub id in MAINTAINER_GITHUB_IDS, so
 *  removing either takes the role away. */
const roleOf = (env: Env, ids: Identity[]): Role => {
  const m = maintainerIds(env);
  return ids.some((i) => i.provider === "github" && m.includes(i.providerUserId)) ? "maintainer" : "member";
};

function toUser(env: Env, id: string, customName: string | null, botBio: string | null, hasAvatar: number, identities: Identity[], suspended = false): User {
  return { id, botBio, displayName: customName || nameFrom(identities), customName, avatar: botBio !== null && hasAvatar ? `/u/${id}/avatar.jpg` : photoFrom(identities), role: roleOf(env, identities), identities, suspended };
}

/** A live (not deleted) user with all identities, or null. */
export async function loadUser(env: Env, id: string): Promise<User | null> {
  const [u, ids] = await env.DB.batch([
    env.DB.prepare("SELECT id, custom_name, bot_bio, bot_avatar IS NOT NULL AS has_avatar, suspended_at FROM users WHERE id = ?1 AND deleted_at IS NULL").bind(id),
    env.DB.prepare("SELECT * FROM identities WHERE user_id = ?1 ORDER BY created_at").bind(id),
  ]);
  const row = (u.results as { id: string; custom_name: string | null; bot_bio: string | null; has_avatar: number; suspended_at: string | null }[])[0];
  if (!row) return null;
  return toUser(env, row.id, row.custom_name, row.bot_bio, row.has_avatar, (ids.results as unknown as IdentityRow[]).map(toIdentity), row.suspended_at !== null);
}

/** Names, photos and sign-ins for many users at once (e.g. bylines), keyed by the ids asked for.
 *  An account merged into another comes back as that account; deleted users come back as
 *  "deleted user"; unknown ids are left out. Safe for cached pages. */
export async function publicUsers(env: Env, userIds: string[]): Promise<Map<string, User & { deleted: boolean }>> {
  const out = new Map<string, User & { deleted: boolean }>();
  const ids = [...new Set(userIds)];
  if (!ids.length) return out;
  const list = JSON.stringify(ids);
  const [us, is] = await env.DB.batch([
    env.DB.prepare(
      `SELECT u.id AS asked, e.id, e.custom_name, e.bot_bio, e.bot_avatar IS NOT NULL AS has_avatar, e.deleted_at FROM users u JOIN users e ON e.id = COALESCE(u.merged_into, u.id)
       WHERE u.id IN (SELECT value FROM json_each(?1))`,
    ).bind(list),
    env.DB.prepare(
      `SELECT * FROM identities WHERE user_id IN
         (SELECT COALESCE(merged_into, id) FROM users WHERE id IN (SELECT value FROM json_each(?1))) ORDER BY created_at`,
    ).bind(list),
  ]);
  const idsBy = new Map<string, Identity[]>();
  for (const r of is.results as unknown as IdentityRow[]) idsBy.set(r.user_id, [...(idsBy.get(r.user_id) ?? []), toIdentity(r)]);
  const byId = new Map<string, User & { deleted: boolean }>();
  for (const r of us.results as { asked: string; id: string; custom_name: string | null; bot_bio: string | null; has_avatar: number; deleted_at: string | null }[]) {
    let p = byId.get(r.id);
    if (!p) {
      p = r.deleted_at
        ? { id: r.id, displayName: DELETED_NAME, customName: null, botBio: null, avatar: "", role: "member", identities: [], suspended: false, deleted: true }
        : { ...toUser(env, r.id, r.custom_name, r.bot_bio, r.has_avatar, idsBy.get(r.id) ?? []), deleted: false };
      byId.set(r.id, p);
    }
    out.set(r.asked, p);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// who is asking

/** The signed-in user, or null. Reads D1: call it only on POSTs, /api/me and no-store pages,
 *  never on publicly cached page views. */
export async function currentUser(env: Env, req: Request): Promise<Actor | null> {
  const tok = cookies(req).get(SESSION_COOKIE);
  if (!tok) return null;
  const id = await sha256hex(tok);
  const s = await env.DB.prepare("SELECT user_id, last_seen FROM sessions WHERE id = ?1 AND expires_at > ?2 AND created_at > ?3")
    .bind(id, nowIso(), later(-SESSION_MAX_DAYS * DAY_MS))
    .first<{ user_id: string; last_seen: string }>();
  if (!s) return null;
  const user = await loadUser(env, s.user_id);
  if (!user) return null;
  if (Date.now() - Date.parse(s.last_seen) > TOUCH_MS) {
    await env.DB.prepare("UPDATE sessions SET last_seen = ?2, expires_at = ?3 WHERE id = ?1")
      .bind(id, nowIso(), later(SESSION_DAYS * DAY_MS))
      .run();
  }
  return { user, sessionId: id };
}

export const isAuthFailure = (x: Actor | AuthFailure): x is AuthFailure => "code" in x && !("user" in x);

/** The signed-in user, or why not. Non-GET requests must come from our own pages. */
export async function requireUser(env: Env, req: Request, opts: { role?: Role } = {}): Promise<Actor | AuthFailure> {
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req, env)) return { code: "origin", status: 403 };
  const a = await currentUser(env, req);
  if (!a) return { code: "signin", status: 401 };
  if (opts.role === "maintainer" && a.user.role !== "maintainer") return { code: "role", status: 403 };
  return a;
}

const FAILURE_MESSAGES: Record<FailureCode, string> = {
  signin: "Sign in first.",
  role: "Your account isn't allowed to do this.",
  origin: "Cross-site requests aren't accepted.",
};
/** JSON error for API callers. HTML forms redirect back to their page instead. */
export function authJson(f: AuthFailure): Response {
  return json({ error: f.code, message: FAILURE_MESSAGES[f.code] }, f.status);
}

// ---------------------------------------------------------------------------------------------
// sessions and cookies

const cookieAttrs = (maxAge: number) => `Path=/; Max-Age=${maxAge}; Secure; SameSite=Lax`;

/** The navbar's display-only cookie: name and photo, read by app.js on cached pages. */
export const loginCookie = (u: User): string =>
  `${LOGIN_COOKIE}=${encodeURIComponent(JSON.stringify({ n: u.displayName, a: u.avatar }))}; ${cookieAttrs(COOKIE_MAX_AGE)}`;

export function clearCookies(): string[] {
  return [`${SESSION_COOKIE}=; HttpOnly; ${cookieAttrs(0)}`, `${LOGIN_COOKIE}=; ${cookieAttrs(0)}`];
}

async function startSession(env: Env, user: User): Promise<string[]> {
  const tok = randomToken();
  const t = nowIso();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?3)")
    .bind(await sha256hex(tok), user.id, t, later(SESSION_DAYS * DAY_MS))
    .run();
  return [`${SESSION_COOKIE}=${tok}; HttpOnly; ${cookieAttrs(COOKIE_MAX_AGE)}`, loginCookie(user)];
}

// ---------------------------------------------------------------------------------------------
// signing in with, or linking, a verified identity (any provider)

export type Provider = "github" | "google" | "orcid";
export const PROVIDER_LABEL: Record<Provider, string> = { github: "GitHub", google: "Google", orcid: "ORCID" };

/** What a provider confirmed about the person. */
export interface Verified {
  provider: Provider;
  providerUserId: string; // stable id: GitHub numeric id, Google "sub", ORCID iD
  handle: string; // GitHub login, Google email domain, ORCID iD
  url: string; // public link, or "" (Google has none)
  name: string; // the person's name there, or ""
  avatar: string; // profile photo URL, or ""
  /** The email the provider vouches for, lowercased; null when it has none; undefined when we
   *  couldn't ask (a failed lookup keeps the one stored). Never shown except on /account. */
  email?: string | null;
}

/** Store or clear the email a sign-in vouches for (identity_emails). */
function saveEmail(env: Env, v: Verified): D1PreparedStatement | null {
  if (v.email === undefined) return null;
  if (v.email === null)
    return env.DB.prepare("DELETE FROM identity_emails WHERE provider = ?1 AND provider_user_id = ?2").bind(v.provider, v.providerUserId);
  return env.DB.prepare(
    `INSERT INTO identity_emails (provider, provider_user_id, email, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (provider, provider_user_id) DO UPDATE SET email = excluded.email, updated_at = excluded.updated_at`,
  ).bind(v.provider, v.providerUserId, v.email, nowIso());
}

/** An account's emails, keyed "provider:providerUserId". For its owner's /account page only. */
export async function accountEmails(env: Env, userId: string): Promise<Map<string, string>> {
  const { results } = await env.DB.prepare(
    `SELECT e.provider, e.provider_user_id, e.email FROM identity_emails e
     JOIN identities i ON i.provider = e.provider AND i.provider_user_id = e.provider_user_id WHERE i.user_id = ?1`,
  )
    .bind(userId)
    .all<{ provider: string; provider_user_id: string; email: string }>();
  return new Map(results.map((r) => [`${r.provider}:${r.provider_user_id}`, r.email]));
}

async function identityOwner(env: Env, v: Verified): Promise<string | null> {
  const r = await env.DB.prepare(
    "SELECT i.user_id FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ?1 AND i.provider_user_id = ?2 AND u.deleted_at IS NULL",
  )
    .bind(v.provider, v.providerUserId)
    .first<{ user_id: string }>();
  return r?.user_id ?? null;
}

const insertIdentity = (env: Env, v: Verified, userId: string, t: string) =>
  env.DB.prepare(
    "INSERT INTO identities (provider, provider_user_id, user_id, handle, url, name, avatar, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  ).bind(v.provider, v.providerUserId, userId, v.handle, v.url, cleanName(v.name).slice(0, 200), v.avatar.slice(0, 500), t);

/** Find or create the user for a verified identity, refreshing what the provider told us (handle,
 *  name, photo). Returns the user's id. */
export async function signInWith(env: Env, v: Verified): Promise<string> {
  const owner = await identityOwner(env, v);
  const email = saveEmail(env, v);
  if (owner) {
    await env.DB.batch([
      env.DB.prepare("UPDATE identities SET handle = ?3, url = ?4, name = ?5, avatar = ?6 WHERE provider = ?1 AND provider_user_id = ?2")
        .bind(v.provider, v.providerUserId, v.handle, v.url, cleanName(v.name).slice(0, 200), v.avatar.slice(0, 500)),
      ...(email ? [email] : []),
    ]);
    return owner;
  }
  const id = randomId();
  const t = nowIso();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, created_at) VALUES (?1, ?2)").bind(id, t),
    insertIdentity(env, v, id, t),
    ...(email ? [email] : []),
  ]);
  return id;
}

/** The end of every provider's callback: link to the signed-in account, or sign in. Adding a
 *  sign-in that already belongs to another account offers to merge the two (/account/merge):
 *  having just signed in with it, the person can reach that account anyway. */
async function identityDone(env: Env, req: Request, v: Verified, mode: "login" | "link", next: string, extraCookies: string[] = []): Promise<Response> {
  if (mode === "link") {
    const me = await currentUser(env, req);
    if (!me) return authMessage(env, 401, "Logged out", "Log in again, then add the account.", "/account", extraCookies);
    const owner = await identityOwner(env, v);
    if (owner && owner !== me.user.id) return redirect303("/account/merge", [...extraCookies, await offerMerge(env, me.user.id, owner, v)]);
    const email = saveEmail(env, v);
    const writes = [...(owner ? [] : [insertIdentity(env, v, me.user.id, nowIso())]), ...(email ? [email] : [])];
    if (writes.length) await env.DB.batch(writes);
    const u = await loadUser(env, me.user.id);
    return redirect303("/account?saved=linked", [...extraCookies, ...(u ? [loginCookie(u)] : [])]);
  }
  const user = await loadUser(env, await signInWith(env, v));
  if (!user) return authMessage(env, 500, "Log-in failed", "Please try again.", "/account", extraCookies);
  // Drop the session this browser held before, if any, rather than leaving it valid.
  const old = cookies(req).get(SESSION_COOKIE);
  if (old) await env.DB.prepare("DELETE FROM sessions WHERE id = ?1").bind(await sha256hex(old)).run();
  return redirect303(safeNext(next), [...extraCookies, ...(await startSession(env, user))]);
}

/** Adding a sign-in to an account takes a deliberate click on /account: link=1 and a same-origin
 *  navigation (Sec-Fetch-Site). Otherwise another site could send a signed-in browser to
 *  /auth/<provider> and, where the provider skips its consent screen, attach the person's
 *  account without them noticing. Signed in without that: "signed-in" (we just go to /account). */
async function startMode(env: Env, req: Request, url: URL): Promise<"login" | "link" | "signed-in"> {
  if (!(await currentUser(env, req))) return "login";
  return url.searchParams.get("link") === "1" && req.headers.get("sec-fetch-site") === "same-origin" ? "link" : "signed-in";
}

// ---------------------------------------------------------------------------------------------
// OAuth plumbing

interface OAuthState {
  s: string; // state
  v: string; // PKCE verifier
  n: string; // where to go afterwards
  m: "login" | "link";
}

async function pkceChallenge(verifier: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(d));
}

function readOAuthCookie(req: Request): OAuthState | null {
  const raw = cookies(req).get(OAUTH_COOKIE);
  if (!raw) return null;
  try {
    const o = JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))) as OAuthState;
    return typeof o.s === "string" && typeof o.v === "string" ? o : null;
  } catch {
    return null;
  }
}

/** Start an OAuth round trip: remember state + PKCE verifier in a short-lived cookie (the
 *  __Host- prefix means only we can set it), then send the browser to the provider. */
async function oauthRedirect(authorizeUrl: string, params: Record<string, string>, st: Omit<OAuthState, "s" | "v">, pkce = true): Promise<Response> {
  const s = randomToken(16);
  const v = randomToken(32);
  const u = new URL(authorizeUrl);
  for (const [k, val] of Object.entries(params)) u.searchParams.set(k, val);
  u.searchParams.set("state", s);
  if (pkce) {
    u.searchParams.set("code_challenge", await pkceChallenge(v));
    u.searchParams.set("code_challenge_method", "S256");
  }
  const cookie = b64url(new TextEncoder().encode(JSON.stringify({ s, v, ...st })));
  return redirect303(u.toString(), [`${OAUTH_COOKIE}=${cookie}; HttpOnly; ${cookieAttrs(600)}`]);
}

/** Check the provider's callback against our cookie. Returns the saved state, or null. */
function oauthCallbackState(req: Request, url: URL): OAuthState | null {
  const st = readOAuthCookie(req);
  return st && url.searchParams.get("state") === st.s && url.searchParams.get("code") ? st : null;
}
const clearOAuthCookie = `${OAUTH_COOKIE}=; HttpOnly; ${cookieAttrs(0)}`;

const UA = "open-cryptology (+https://github.com/selanavot/open-cryptology)";

function authMessage(env: Env, status: number, title: string, text: string, next = "/", setCookies: string[] = []): Response {
  const res = messagePage(env, status, title, html`<p>${text}</p><p><a href="${safeNext(next)}">Go back</a></p>`, {
    cache: "no-store",
    noindex: true,
  });
  for (const c of setCookies) res.headers.append("set-cookie", c);
  return res;
}

// ---------------------------------------------------------------------------------------------
// routes: /auth/*, /api/me

/** Made-up test accounts: local test servers only (AUTH_DEV_LOGIN=1 and a localhost AUTH_ORIGIN). */
export const devLogin = (env: Env): boolean =>
  env.AUTH_DEV_LOGIN === "1" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(env.AUTH_ORIGIN ?? "");

export function isAuthPath(path: string): boolean {
  return path.startsWith("/auth/") || path === "/api/me";
}

export async function handleAuth(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const isGet = req.method === "GET" || req.method === "HEAD";

  if (path === "/api/me") {
    if (!isGet) return json({ error: "method_not_allowed" }, 405);
    const a = await currentUser(env, req);
    if (!a) return authJson({ code: "signin", status: 401 });
    const u = a.user;
    return json({ user: { id: u.id, displayName: u.displayName, customName: u.customName, avatar: u.avatar, role: u.role, identities: u.identities } });
  }

  if (path === "/auth/logout") {
    if (req.method !== "POST") return authMessage(env, 405, "Use the sign-out button", "Signing out needs the button on the account page.");
    if (!sameOrigin(req, env)) return authMessage(env, 403, "Rejected", "Cross-site requests aren't accepted.");
    const tok = cookies(req).get(SESSION_COOKIE);
    if (tok) {
      // Logging out also disconnects the account's agents (agentapi.ts): live tokens stop working
      // and approvals they haven't collected yet are withdrawn.
      const sid = await sha256hex(tok);
      const who = "(SELECT user_id FROM sessions WHERE id = ?1)";
      await env.DB.batch([
        env.DB.prepare(`UPDATE api_tokens SET revoked_at = ?2 WHERE revoked_at IS NULL AND user_id = ${who}`).bind(sid, new Date().toISOString()),
        env.DB.prepare(`UPDATE agent_connect SET status = 'denied' WHERE status = 'approved' AND user_id = ${who}`).bind(sid),
        env.DB.prepare("DELETE FROM sessions WHERE id = ?1").bind(sid),
      ]);
    }
    const form = await req.formData().catch(() => null);
    return redirect303(safeNext(form?.get("next")?.toString()), clearCookies());
  }

  // /auth/<provider> starts a sign-in (or, with link=1 from /account, adds the account); the
  // provider sends the browser back to /auth/<provider>/callback.
  const pm = /^\/auth\/(github|google|orcid)(\/callback)?$/.exec(path);
  if (pm && isGet) {
    const p = PROVIDERS[pm[1] as Provider];
    const label = PROVIDER_LABEL[pm[1] as Provider];
    const redirectUri = `${authOrigin(env, url)}/auth/${pm[1]}/callback`;
    if (!pm[2]) {
      const next = safeNext(url.searchParams.get("next"));
      if (!p.ready(env)) return authMessage(env, 503, "Sign-in isn't set up", `${label} sign-in isn't configured on this server yet.`, next);
      const mode = await startMode(env, req, url);
      if (mode === "signed-in") return redirect303("/account");
      const a = p.authorize(env, redirectUri);
      return oauthRedirect(a.url, a.params, { n: next, m: mode }, a.pkce);
    }
    const st = oauthCallbackState(req, url);
    if (!st) {
      const cancelled = url.searchParams.get("error") === "access_denied";
      return authMessage(env, 400, cancelled ? "Sign-in cancelled" : "Sign-in failed",
        cancelled ? `You didn't authorize the ${label} sign-in.` : "The sign-in link expired or was already used. Please try again.");
    }
    if (!p.ready(env)) return authMessage(env, 503, "Sign-in isn't set up", `${label} sign-in isn't configured on this server yet.`);
    const v = await p.exchange(env, url.searchParams.get("code")!, st.v, redirectUri);
    if (!v) return authMessage(env, 502, "Sign-in failed", `${label} didn't confirm the sign-in. Please try again.`, st.n, [clearOAuthCookie]);
    return identityDone(env, req, v, st.m, st.n, [clearOAuthCookie]);
  }

  // Local testing without OAuth apps: made-up accounts. Needs AUTH_DEV_LOGIN=1 *and* a localhost
  // AUTH_ORIGIN (both only in .dev.vars), so one stray setting can't switch it on in production.
  // Like the real routes, they sign in, or with link=1 from /account add the account.
  if (devLogin(env) && isGet && path.startsWith("/auth/dev-")) {
    const q = url.searchParams;
    const next = safeNext(q.get("next") ?? "/account");
    let v: Verified | null = null;
    if (path === "/auth/dev-login") {
      const login = q.get("login") ?? "";
      const ghid = Number(q.get("ghid"));
      if (/^[A-Za-z0-9-]{1,39}$/.test(login) && Number.isInteger(ghid) && ghid > 0) v = githubVerified({ id: ghid, login, name: q.get("name") ?? "", avatar: "" });
    } else if (path === "/auth/dev-orcid") {
      const orcid = q.get("orcid") ?? "";
      if (ORCID_RE.test(orcid)) v = orcidVerified(orcid, q.get("name") ?? "");
    } else if (path === "/auth/dev-google") {
      const sub = q.get("sub") ?? "";
      const email = q.get("email") ?? "";
      if (/^\d{1,30}$/.test(sub) && /@[a-z0-9.-]+$/i.test(email)) v = googleVerified({ sub, email, name: q.get("name") ?? "", avatar: "" });
    }
    // dev-login and dev-orcid take an optional email=, as GitHub and ORCID may give one.
    if (v && v.provider !== "google") v.email = parseEmail(q.get("email") ?? "");
    if (!v) return authMessage(env, 400, "Bad dev sign-in", "See docs/ACCOUNTS.md for the dev sign-in routes.");
    const mode = await startMode(env, req, url);
    if (mode === "signed-in") return redirect303("/account");
    return identityDone(env, req, v, mode, next);
  }

  return authMessage(env, 404, "Not found", "There's nothing here.");
}

// ---------------------------------------------------------------------------------------------
// providers

interface ProviderConfig {
  ready(env: Env): boolean;
  authorize(env: Env, redirectUri: string): { url: string; params: Record<string, string>; pkce: boolean };
  exchange(env: Env, code: string, verifier: string, redirectUri: string): Promise<Verified | null>;
}

const form = (o: Record<string, string>) => ({
  method: "POST",
  headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
  body: new URLSearchParams(o),
});

// The providers' access tokens are used only during sign-in, to read the profile (and email), and never stored.
const PROVIDERS: Record<Provider, ProviderConfig> = {
  github: {
    ready: (env) => !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    authorize: (env, redirect_uri) => ({
      url: "https://github.com/login/oauth/authorize",
      params: { client_id: env.GITHUB_CLIENT_ID!, redirect_uri, allow_signup: "true", scope: "user:email" }, // public profile + email addresses (read-only)
      pkce: true,
    }),
    async exchange(env, code, code_verifier, redirect_uri) {
      const tr = await fetch(
        "https://github.com/login/oauth/access_token",
        form({ client_id: env.GITHUB_CLIENT_ID!, client_secret: env.GITHUB_CLIENT_SECRET!, code, redirect_uri, code_verifier }),
      );
      const tok = (await tr.json().catch(() => null)) as { access_token?: string } | null;
      if (!tok?.access_token) return null;
      const gh = (p: string) =>
        fetch(`https://api.github.com${p}`, {
          headers: { authorization: `Bearer ${tok.access_token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": UA },
        });
      const [ur, er] = await Promise.all([gh("/user"), gh("/user/emails").catch(() => null)]);
      if (!ur.ok) return null;
      const u = (await ur.json()) as { id?: unknown; login?: unknown; name?: unknown; avatar_url?: unknown };
      if (typeof u.id !== "number" || typeof u.login !== "string") return null;
      const v = githubVerified({ id: u.id, login: u.login, name: typeof u.name === "string" ? u.name : "", avatar: typeof u.avatar_url === "string" ? u.avatar_url : "" });
      // Without the scope (someone declined it, or an old token) /user/emails is a 404: keep what we have.
      if (er?.ok) v.email = githubEmail(await er.json().catch(() => null));
      return v;
    },
  },
  google: {
    ready: (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    authorize: (env, redirect_uri) => ({
      url: "https://accounts.google.com/o/oauth2/v2/auth",
      params: { client_id: env.GOOGLE_CLIENT_ID!, redirect_uri, response_type: "code", scope: "openid email profile", prompt: "select_account" },
      pkce: true,
    }),
    async exchange(env, code, code_verifier, redirect_uri) {
      const r = await fetch(
        "https://oauth2.googleapis.com/token",
        form({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, code, code_verifier, redirect_uri, grant_type: "authorization_code" }),
      );
      const j = (await r.json().catch(() => null)) as { id_token?: string } | null;
      // The ID token comes straight from Google's token endpoint over TLS, so its claims can be read
      // without checking the signature (OpenID Connect Core 3.1.3.7); we still check who it is for.
      const c = j?.id_token ? jwtClaims(j.id_token) : null;
      if (!c || c.aud !== env.GOOGLE_CLIENT_ID || !["https://accounts.google.com", "accounts.google.com"].includes(String(c.iss))) return null;
      if (typeof c.exp !== "number" || c.exp * 1000 < Date.now() || c.email_verified !== true) return null;
      if (typeof c.sub !== "string" || typeof c.email !== "string") return null;
      return googleVerified({
        sub: c.sub,
        email: c.email,
        name: typeof c.name === "string" ? c.name : "",
        avatar: typeof c.picture === "string" ? c.picture : "",
      });
    },
  },
  orcid: {
    ready: (env) => !!(env.ORCID_CLIENT_ID && env.ORCID_CLIENT_SECRET),
    authorize: (env, redirect_uri) => ({
      url: `${orcidBase(env)}/oauth/authorize`,
      params: { client_id: env.ORCID_CLIENT_ID!, response_type: "code", scope: "/authenticate", redirect_uri },
      pkce: false, // ORCID's public API doesn't document PKCE; state + the client secret protect the code
    }),
    async exchange(env, code, _verifier, redirect_uri) {
      const r = await fetch(
        `${orcidBase(env)}/oauth/token`,
        form({ client_id: env.ORCID_CLIENT_ID!, client_secret: env.ORCID_CLIENT_SECRET!, grant_type: "authorization_code", code, redirect_uri }),
      );
      // The token response itself carries the iD and the name.
      const j = (await r.json().catch(() => null)) as { orcid?: string; name?: string } | null;
      if (!j?.orcid || !ORCID_RE.test(j.orcid)) return null;
      const v = orcidVerified(j.orcid, j.name ?? "", orcidBase(env));
      // The /authenticate scope reads only public data: the record's public emails, if any.
      const er = await fetch(`${orcidPub(env)}/v3.0/${j.orcid}/email`, { headers: { accept: "application/json", "user-agent": UA } }).catch(() => null);
      if (er?.ok) v.email = orcidEmail(await er.json().catch(() => null));
      return v;
    },
  },
};

/** Photos are shown only from these hosts (they are also in the CSP's img-src). */
const PHOTO_RE = /^https:\/\/(avatars\.githubusercontent\.com|[a-z0-9-]+\.googleusercontent\.com)\//;
const photo = (u: string) => (PHOTO_RE.test(u) ? u : "");

const githubVerified = (gh: { id: number; login: string; name: string; avatar: string }): Verified => ({
  provider: "github",
  providerUserId: String(gh.id),
  handle: gh.login,
  url: `https://github.com/${gh.login}`,
  name: gh.name,
  avatar: photo(gh.avatar),
});

export const ORCID_RE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;
const orcidBase = (env: Env) => (env.ORCID_BASE || "https://orcid.org").replace(/\/$/, "");
/** ORCID's public API: pub.orcid.org, or pub.sandbox.orcid.org for the sandbox. */
const orcidPub = (env: Env) => orcidBase(env).replace("://", "://pub.");

/** GitHub's primary email, if verified (GET /user/emails). */
export function githubEmail(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  const e = list.find((x) => x && typeof x === "object" && x.primary === true && x.verified === true);
  return typeof e?.email === "string" ? parseEmail(e.email) : null;
}

/** An ORCID record's verified email, the primary one first (GET /v3.0/<iD>/email; public only). */
export function orcidEmail(j: unknown): string | null {
  const list = (j as { email?: unknown } | null)?.email;
  if (!Array.isArray(list)) return null;
  const ok = list.filter((x) => x && typeof x === "object" && x.verified === true && typeof x.email === "string");
  const e = ok.find((x) => x.primary === true) ?? ok[0];
  return e ? parseEmail(e.email) : null;
}
const orcidVerified = (orcid: string, name: string, base = "https://orcid.org"): Verified => ({
  provider: "orcid",
  providerUserId: orcid,
  handle: orcid,
  url: `${base}/${orcid}`, // the sandbox's iDs live on sandbox.orcid.org
  name,
  avatar: "",
});

/** Google: keyed on "sub". We keep the email's domain (shown as "verified @mit.edu" for
 *  institutions). */
const googleVerified = (g: { sub: string; email: string; name: string; avatar: string }): Verified => ({
  provider: "google",
  providerUserId: g.sub,
  handle: g.email.slice(g.email.lastIndexOf("@") + 1).toLowerCase(),
  url: "",
  name: g.name,
  avatar: photo(g.avatar),
  email: parseEmail(g.email), // the callback checks email_verified
});

/** Consumer mail domains: a Google sign-in from these says nothing about an institution. */
export const PERSONAL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

function jwtClaims(jwt: string): Record<string, unknown> | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const bin = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Sign-ins are only ever added (or merged in from another account), never removed one by one:
// the display name is the only thing a person edits. Deleting the account removes them all.

// ---------------------------------------------------------------------------------------------
// merging two accounts (/account/merge)

const MERGE_COOKIE = "__Host-oc_merge";
const MERGE_MINUTES = 10;
export const clearMergeCookie = `${MERGE_COOKIE}=; HttpOnly; ${cookieAttrs(0)}`;

/** Remember, for a few minutes, that this browser proved it controls a sign-in of another account.
 *  Returns the cookie that points at the offer; D1 keeps only its hash. */
async function offerMerge(env: Env, userId: string, otherId: string, v: Verified): Promise<string> {
  const tok = randomToken();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pending_merges WHERE user_id = ?1 OR expires_at < ?2").bind(userId, nowIso()),
    env.DB.prepare(
      "INSERT INTO pending_merges (id, user_id, other_user_id, provider, provider_user_id, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    ).bind(await sha256hex(tok), userId, otherId, v.provider, v.providerUserId, later(MERGE_MINUTES * 60_000)),
  ]);
  return `${MERGE_COOKIE}=${tok}; HttpOnly; ${cookieAttrs(MERGE_MINUTES * 60)}`;
}

export interface MergeOffer {
  id: string;
  other: User;
  via: Identity; // the sign-in that was just used, now on the other account
}

/** The merge this browser was offered, if it is still valid: same signed-in user, not expired,
 *  and the other account still exists and still holds the sign-in. */
export async function pendingMerge(env: Env, req: Request, userId: string): Promise<MergeOffer | null> {
  const tok = cookies(req).get(MERGE_COOKIE);
  if (!tok) return null;
  const id = await sha256hex(tok);
  const r = await env.DB.prepare("SELECT other_user_id, provider, provider_user_id FROM pending_merges WHERE id = ?1 AND user_id = ?2 AND expires_at > ?3")
    .bind(id, userId, nowIso())
    .first<{ other_user_id: string; provider: string; provider_user_id: string }>();
  if (!r) return null;
  const other = await loadUser(env, r.other_user_id);
  const via = other?.identities.find((i) => i.provider === r.provider && i.providerUserId === r.provider_user_id);
  return other && via ? { id, other, via } : null;
}

/** Merge `goneId` into `keepId`: its sign-ins move over, its sessions end, and it becomes a
 *  tombstone pointing at `keepId` (merged_into), so what it posted is credited to the kept account
 *  without touching other tables. A custom name survives: the kept account's, else the merged one's. */
export async function mergeAccounts(env: Env, keepId: string, goneId: string, offerId: string): Promise<void> {
  await env.DB.batch([
    // A name someone typed beats any name from a log-in method: keep the kept account's own name,
    // else take the merged account's.
    env.DB.prepare("UPDATE users SET custom_name = COALESCE(custom_name, (SELECT custom_name FROM users WHERE id = ?2)) WHERE id = ?1").bind(keepId, goneId),
    env.DB.prepare("UPDATE identities SET user_id = ?1 WHERE user_id = ?2").bind(keepId, goneId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(goneId),
    env.DB.prepare("UPDATE api_tokens SET user_id = ?1 WHERE user_id = ?2").bind(keepId, goneId),
    env.DB.prepare("UPDATE users SET merged_into = ?1 WHERE merged_into = ?2").bind(keepId, goneId),
    env.DB.prepare("UPDATE users SET custom_name = NULL, deleted_at = ?3, merged_into = ?1 WHERE id = ?2 AND deleted_at IS NULL").bind(keepId, goneId, nowIso()),
    env.DB.prepare("DELETE FROM pending_merges WHERE id = ?1 OR other_user_id = ?2 OR user_id = ?2").bind(offerId, goneId),
  ]);
}

export async function dropMerge(env: Env, offerId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM pending_merges WHERE id = ?1").bind(offerId).run();
}

/** Delete an account, keeping a tombstone so what it posted stays attributed to "deleted user":
 *  sign-ins and sessions go; the users row stays with deleted_at set and the name freed. */
export async function deleteAccount(env: Env, userId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(userId),
    env.DB.prepare("UPDATE api_tokens SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL").bind(userId, nowIso()),
    env.DB.prepare(
      "DELETE FROM identity_emails WHERE (provider, provider_user_id) IN (SELECT provider, provider_user_id FROM identities WHERE user_id = ?1)",
    ).bind(userId),
    env.DB.prepare("DELETE FROM identities WHERE user_id = ?1").bind(userId),
    env.DB.prepare("DELETE FROM comment_votes WHERE user_id = ?1").bind(userId),
    env.DB.prepare("UPDATE users SET custom_name = NULL, deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL").bind(userId, nowIso()),
  ]);
}
