// Accounts: sign-in with GitHub, browser sessions, and the helpers other features use to find out
// who is making a request (design: docs/ACCOUNTS.md; tables: the "accounts" section of
// db/schema.sql). We store no passwords, no provider access tokens (they are dropped as soon as
// the profile is read) and no email addresses.
//
// Sessions: the __Host-oc_session cookie holds 32 random bytes; D1 keeps only their SHA-256.
// Pages are publicly cached, so nothing signed-in is rendered into them: app.js reads the
// display-only oc_login cookie, and the session itself is looked up only on POSTs, /api/me and
// the no-store account pages (currentUser / requireUser).
import type { Env } from "./db";
import { html } from "./html";
import { messagePage } from "./layout";

export type Role = "member" | "trusted" | "maintainer";
export type Kind = "human" | "bot";
const ROLE_RANK: Record<Role, number> = { member: 0, trusted: 1, maintainer: 2 };

export interface Identity {
  provider: "github" | "orcid";
  providerUserId: string; // GitHub numeric id / ORCID iD
  handle: string; // GitHub login / ORCID iD
  url: string; // https://github.com/<login> | https://orcid.org/<iD>
  providerCreatedAt?: string; // GitHub account creation time (ISO)
  public: boolean;
}
export interface User {
  id: string;
  displayName: string;
  role: Role;
  kind: Kind;
  owner?: { id: string; displayName: string }; // bots only
  banned: boolean;
  identities: Identity[]; // all of them, hidden ones included (this is the signed-in user's view)
}
export interface Actor {
  user: User;
  via: "session" | "token"; // "token" (or a bot account) => label the content agent-made
  tokenId?: string;
  scopes?: string[];
}
export type FailureCode = "signin" | "banned" | "role" | "scope" | "origin";
export interface AuthFailure {
  code: FailureCode;
  status: 401 | 403;
}

export const SESSION_COOKIE = "__Host-oc_session";
export const LOGIN_COOKIE = "oc_login"; // display only: URI-encoded display name, never trusted
const OAUTH_COOKIE = "__Host-oc_oauth";
const SESSION_DAYS = 30; // sliding expiry, enforced in D1
const COOKIE_MAX_AGE = 400 * 86400; // browsers cap cookies at 400 days; D1 decides validity
const TOUCH_MS = 3600_000; // refresh last_seen / last_used at most once an hour
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
 *  production host, so local runs set AUTH_ORIGIN=http://localhost:8787 in .dev.vars. */
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
// display names

export const DELETED_NAME = "deleted user";
/** Uniqueness key: NFKC, case-folded, whitespace collapsed. */
export const nameKey = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------------------------
// loading users

interface UserRow {
  id: string;
  display_name: string;
  role: Role;
  kind: Kind;
  owner_user_id: string | null;
  owner_name: string | null;
  banned: number;
  deleted_at: string | null;
}
interface IdentityRow {
  provider: "github" | "orcid";
  provider_user_id: string;
  user_id: string;
  handle: string;
  url: string;
  provider_created_at: string | null;
  public: number;
}

const USER_SELECT = `SELECT u.id, u.display_name, u.role, u.kind, u.owner_user_id, o.display_name AS owner_name,
  u.banned, u.deleted_at FROM users u LEFT JOIN users o ON o.id = u.owner_user_id`;

export const toIdentity = (r: IdentityRow): Identity => ({
  provider: r.provider,
  providerUserId: r.provider_user_id,
  handle: r.handle,
  url: r.url,
  ...(r.provider_created_at ? { providerCreatedAt: r.provider_created_at } : {}),
  public: !!r.public,
});

function toUser(r: UserRow, ids: IdentityRow[]): User {
  return {
    id: r.id,
    displayName: r.display_name,
    role: r.role,
    kind: r.kind,
    ...(r.owner_user_id ? { owner: { id: r.owner_user_id, displayName: r.owner_name ?? DELETED_NAME } } : {}),
    banned: !!r.banned,
    identities: ids.map(toIdentity),
  };
}

/** A live (not deleted) user with all identities, or null. */
export async function loadUser(env: Env, id: string): Promise<User | null> {
  const [u, ids] = await env.DB.batch([
    env.DB.prepare(`${USER_SELECT} WHERE u.id = ?1 AND u.deleted_at IS NULL`).bind(id),
    env.DB.prepare("SELECT * FROM identities WHERE user_id = ?1 ORDER BY provider, created_at").bind(id),
  ]);
  const row = (u.results as unknown as UserRow[])[0];
  return row ? toUser(row, ids.results as unknown as IdentityRow[]) : null;
}

// ---------------------------------------------------------------------------------------------
// who is asking

/** The signed-in user (cookie session) or token holder, or null. Reads D1: call it only on
 *  POSTs, /api/me and no-store pages, never on publicly cached page views. */
export async function currentUser(env: Env, req: Request): Promise<Actor | null> {
  const authz = req.headers.get("authorization");
  if (authz) return tokenActor(env, authz);
  const tok = cookies(req).get(SESSION_COOKIE);
  if (!tok) return null;
  const id = await sha256hex(tok);
  const s = await env.DB.prepare("SELECT user_id, last_seen FROM sessions WHERE id = ?1 AND expires_at > ?2")
    .bind(id, nowIso())
    .first<{ user_id: string; last_seen: string }>();
  if (!s) return null;
  const user = await loadUser(env, s.user_id);
  if (!user || user.kind !== "human") return null;
  if (Date.now() - Date.parse(s.last_seen) > TOUCH_MS) {
    await env.DB.prepare("UPDATE sessions SET last_seen = ?2, expires_at = ?3 WHERE id = ?1")
      .bind(id, nowIso(), later(SESSION_DAYS * DAY_MS))
      .run();
  }
  return { user, via: "session" };
}

// ---------------------------------------------------------------------------------------------
// API tokens (agents and bots): "Authorization: Bearer oct_..."

export const SCOPES = ["comment", "upload"] as const;
export type Scope = (typeof SCOPES)[number];
export const TOKEN_PREFIX = "oct_";
export const MAX_TOKENS = 20; // active tokens per account

/** The token's account, or null for a missing, malformed, unknown or revoked token. */
async function tokenActor(env: Env, authz: string): Promise<Actor | null> {
  const m = /^Bearer\s+(oct_[A-Za-z0-9_-]{43})\s*$/.exec(authz);
  if (!m) return null;
  const t = await env.DB.prepare("SELECT id, user_id, scopes, last_used FROM api_tokens WHERE hash = ?1 AND revoked_at IS NULL")
    .bind(await sha256hex(m[1]))
    .first<{ id: string; user_id: string; scopes: string; last_used: string | null }>();
  if (!t) return null;
  const user = await loadUser(env, t.user_id);
  if (!user) return null;
  if (!t.last_used || Date.now() - Date.parse(t.last_used) > TOUCH_MS)
    await env.DB.prepare("UPDATE api_tokens SET last_used = ?2 WHERE id = ?1").bind(t.id, nowIso()).run();
  return { user, via: "token", tokenId: t.id, scopes: t.scopes.split(" ").filter(Boolean) };
}

/** Content from this actor is labelled agent-made: it came through a token, or from a bot. */
export const isAgent = (a: Actor): boolean => a.via === "token" || a.user.kind === "bot";

export interface TokenInfo {
  id: string;
  user_id: string;
  name: string;
  scopes: string;
  created_at: string;
  last_used: string | null;
}

/** Active tokens acting as any of these accounts (a user and the bots they run). */
export async function listTokens(env: Env, userIds: string[]): Promise<TokenInfo[]> {
  const r = await env.DB.prepare(
    `SELECT id, user_id, name, scopes, created_at, last_used FROM api_tokens
     WHERE revoked_at IS NULL AND user_id IN (SELECT value FROM json_each(?1)) ORDER BY created_at`,
  )
    .bind(JSON.stringify(userIds))
    .all<TokenInfo>();
  return r.results;
}

/** Create a token for an account; returns the secret (shown once) or a problem. */
export async function createToken(env: Env, userId: string, name: string, scopes: string[]): Promise<{ token: string } | { problem: string }> {
  const n = cleanName(name).slice(0, 60);
  if (!n) return { problem: "Give the token a name, e.g. “my Claude agent”." };
  const sc = SCOPES.filter((s) => scopes.includes(s));
  if (!sc.length) return { problem: "Pick at least one thing the token may do." };
  const count = await env.DB.prepare("SELECT count(*) AS n FROM api_tokens WHERE user_id = ?1 AND revoked_at IS NULL").bind(userId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_TOKENS) return { problem: `An account can have at most ${MAX_TOKENS} tokens; revoke one first.` };
  const token = TOKEN_PREFIX + randomToken(32);
  await env.DB.prepare("INSERT INTO api_tokens (id, hash, user_id, name, scopes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(randomId(), await sha256hex(token), userId, n, sc.join(" "), nowIso())
    .run();
  return { token };
}

/** Revoke a token acting as one of these accounts. Returns whether one was revoked. */
export async function revokeToken(env: Env, tokenId: string, userIds: string[]): Promise<boolean> {
  const r = await env.DB.prepare(
    "UPDATE api_tokens SET revoked_at = ?3 WHERE id = ?1 AND revoked_at IS NULL AND user_id IN (SELECT value FROM json_each(?2))",
  )
    .bind(tokenId, JSON.stringify(userIds), nowIso())
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export const atLeast = (user: User, role: Role): boolean => ROLE_RANK[user.role] >= ROLE_RANK[role];
export const isAuthFailure = (x: Actor | AuthFailure): x is AuthFailure => "code" in x && !("user" in x);

/** The actor, or why not. Cookie-authenticated non-GET requests must come from our own pages. */
export async function requireUser(
  env: Env,
  req: Request,
  opts: { role?: Role; scope?: string } = {},
): Promise<Actor | AuthFailure> {
  const viaCookie = !req.headers.get("authorization");
  if (viaCookie && req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req, env)) return { code: "origin", status: 403 };
  const a = await currentUser(env, req);
  if (!a) return { code: "signin", status: 401 };
  if (a.user.banned) return { code: "banned", status: 403 };
  if (opts.role && !atLeast(a.user, opts.role)) return { code: "role", status: 403 };
  if (opts.scope && a.scopes && !a.scopes.includes(opts.scope)) return { code: "scope", status: 403 };
  return a;
}

const FAILURE_MESSAGES: Record<FailureCode, string> = {
  signin: "Sign in first (a browser session, or Authorization: Bearer <token>).",
  banned: "This account is banned.",
  role: "Your account isn't allowed to do this.",
  scope: "This token doesn't have the scope this needs.",
  origin: "Cross-site requests aren't accepted.",
};
/** JSON error for API callers. HTML forms redirect back to their page instead. */
export function authJson(f: AuthFailure): Response {
  return json({ error: f.code, message: FAILURE_MESSAGES[f.code] }, f.status);
}

/** Public JSON shape of the signed-in user (GET /api/me). */
export function userJson(u: User) {
  return {
    id: u.id,
    displayName: u.displayName,
    role: u.role,
    kind: u.kind,
    ...(u.owner ? { owner: u.owner } : {}),
    banned: u.banned,
    profile: `/u/${u.id}`,
    identities: u.identities,
  };
}

// ---------------------------------------------------------------------------------------------
// sessions and cookies

const cookieAttrs = (maxAge: number) => `Path=/; Max-Age=${maxAge}; Secure; SameSite=Lax`;

export const loginCookie = (displayName: string): string =>
  `${LOGIN_COOKIE}=${encodeURIComponent(displayName)}; ${cookieAttrs(COOKIE_MAX_AGE)}`;

function clearCookies(): string[] {
  return [`${SESSION_COOKIE}=; HttpOnly; ${cookieAttrs(0)}`, `${LOGIN_COOKIE}=; ${cookieAttrs(0)}`];
}

async function startSession(env: Env, user: { id: string; display_name: string }): Promise<string[]> {
  const tok = randomToken();
  const t = nowIso();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?3)")
    .bind(await sha256hex(tok), user.id, t, later(SESSION_DAYS * DAY_MS))
    .run();
  return [`${SESSION_COOKIE}=${tok}; HttpOnly; ${cookieAttrs(COOKIE_MAX_AGE)}`, loginCookie(user.display_name)];
}

// ---------------------------------------------------------------------------------------------
// GitHub sign-in

export interface GithubProfile {
  id: number;
  login: string;
  created_at?: string;
}

const isMaintainerGithub = (env: Env, id: string) =>
  (env.MAINTAINER_GITHUB_IDS ?? "").split(",").map((s) => s.trim()).includes(id);

/** Find or create the user for a GitHub account; refresh the stored login. */
export async function userForGithub(env: Env, gh: GithubProfile): Promise<{ id: string; display_name: string }> {
  const ghId = String(gh.id);
  const url = `https://github.com/${gh.login}`;
  const existing = await env.DB.prepare(
    `SELECT u.id, u.display_name, u.role FROM identities i JOIN users u ON u.id = i.user_id
     WHERE i.provider = 'github' AND i.provider_user_id = ?1 AND u.deleted_at IS NULL`,
  )
    .bind(ghId)
    .first<{ id: string; display_name: string; role: Role }>();
  if (existing) {
    const stmts = [
      env.DB.prepare(
        "UPDATE identities SET handle = ?2, url = ?3, provider_created_at = COALESCE(?4, provider_created_at) WHERE provider = 'github' AND provider_user_id = ?1",
      ).bind(ghId, gh.login, url, gh.created_at ?? null),
    ];
    if (existing.role !== "maintainer" && isMaintainerGithub(env, ghId))
      stmts.push(env.DB.prepare("UPDATE users SET role = 'maintainer' WHERE id = ?1").bind(existing.id));
    await env.DB.batch(stmts);
    return existing;
  }
  // New account: display name = the GitHub login. A login's owner has priority over a name someone
  // else chose: such a user is renamed to "user-<id>" (they can pick another name).
  const id = randomId();
  const t = nowIso();
  const key = nameKey(gh.login);
  const role: Role = isMaintainerGithub(env, ghId) ? "maintainer" : "member";
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET display_name = 'user-' || id, name_key = 'user-' || id WHERE name_key = ?1").bind(key),
    env.DB.prepare("INSERT INTO users (id, display_name, name_key, role, kind, created_at) VALUES (?1, ?2, ?3, ?4, 'human', ?5)").bind(
      id,
      gh.login,
      key,
      role,
      t,
    ),
    env.DB.prepare(
      `INSERT INTO identities (provider, provider_user_id, user_id, handle, url, provider_created_at, public, created_at)
       VALUES ('github', ?1, ?2, ?3, ?4, ?5, 1, ?6)`,
    ).bind(ghId, id, gh.login, url, gh.created_at ?? null, t),
  ]);
  return { id, display_name: gh.login };
}

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
export async function oauthRedirect(authorizeUrl: string, params: Record<string, string>, st: Omit<OAuthState, "s" | "v">): Promise<Response> {
  const s = randomToken(16);
  const v = randomToken(32);
  const u = new URL(authorizeUrl);
  for (const [k, val] of Object.entries(params)) u.searchParams.set(k, val);
  u.searchParams.set("state", s);
  u.searchParams.set("code_challenge", await pkceChallenge(v));
  u.searchParams.set("code_challenge_method", "S256");
  const cookie = b64url(new TextEncoder().encode(JSON.stringify({ s, v, ...st })));
  return redirect303(u.toString(), [`${OAUTH_COOKIE}=${cookie}; HttpOnly; ${cookieAttrs(600)}`]);
}

/** Check the provider's callback against our cookie. Returns the saved state, or null. */
export function oauthCallbackState(req: Request, url: URL): OAuthState | null {
  const st = readOAuthCookie(req);
  return st && url.searchParams.get("state") === st.s && url.searchParams.get("code") ? st : null;
}
export const clearOAuthCookie = `${OAUTH_COOKIE}=; HttpOnly; ${cookieAttrs(0)}`;

const UA = "open-cryptology (+https://github.com/selanavot/open-cryptology)";

async function githubProfile(env: Env, code: string, verifier: string, redirectUri: string): Promise<GithubProfile | null> {
  const tr = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID!,
      client_secret: env.GITHUB_CLIENT_SECRET!,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  const tok = (await tr.json().catch(() => null)) as { access_token?: string } | null;
  if (!tok?.access_token) return null;
  const ur = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${tok.access_token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": UA,
    },
  });
  if (!ur.ok) return null;
  const u = (await ur.json()) as GithubProfile;
  return typeof u.id === "number" && typeof u.login === "string" ? u : null;
  // The access token goes out of scope here: it is never stored.
}

function authMessage(env: Env, status: number, title: string, text: string, next = "/"): Response {
  return messagePage(env, status, title, html`<p>${text}</p><p><a href="${safeNext(next)}">Go back</a></p>`, {
    cache: "no-store",
    noindex: true,
  });
}

// ---------------------------------------------------------------------------------------------
// routes: /auth/*, /api/me

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
    return json({ user: userJson(a.user), via: a.via, ...(a.scopes ? { scopes: a.scopes } : {}) });
  }

  if (path === "/auth/github" && isGet) {
    const next = safeNext(url.searchParams.get("next"));
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET)
      return authMessage(env, 503, "Sign-in isn't set up", "GitHub sign-in isn't configured on this server yet.", next);
    return oauthRedirect(
      "https://github.com/login/oauth/authorize",
      { client_id: env.GITHUB_CLIENT_ID, redirect_uri: `${authOrigin(env, url)}/auth/github/callback`, allow_signup: "true" },
      { n: next, m: "login" },
    );
  }

  if (path === "/auth/github/callback" && isGet) {
    const st = oauthCallbackState(req, url);
    if (!st) {
      const cancelled = url.searchParams.get("error") === "access_denied";
      return authMessage(env, 400, cancelled ? "Sign-in cancelled" : "Sign-in failed",
        cancelled ? "You didn't authorize the sign-in." : "The sign-in link expired or was already used. Please try again.");
    }
    const gh = await githubProfile(env, url.searchParams.get("code")!, st.v, `${authOrigin(env, url)}/auth/github/callback`);
    if (!gh) return authMessage(env, 502, "Sign-in failed", "GitHub didn't confirm the sign-in. Please try again.", st.n);
    const user = await userForGithub(env, gh);
    return redirect303(safeNext(st.n), [clearOAuthCookie, ...(await startSession(env, user))]);
  }

  // Local testing without a GitHub OAuth app: AUTH_DEV_LOGIN=1 in .dev.vars (never in production).
  if (path === "/auth/dev-login" && isGet && env.AUTH_DEV_LOGIN === "1") {
    const login = url.searchParams.get("login") ?? "";
    const ghid = Number(url.searchParams.get("ghid"));
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login) || !Number.isInteger(ghid) || ghid <= 0)
      return authMessage(env, 400, "Bad dev login", "Use /auth/dev-login?login=<github-login>&ghid=<number>.");
    const user = await userForGithub(env, { id: ghid, login, created_at: url.searchParams.get("created") ?? "2015-01-01T00:00:00Z" });
    return redirect303(safeNext(url.searchParams.get("next")), await startSession(env, user));
  }

  if (path === "/auth/logout") {
    if (req.method !== "POST") return authMessage(env, 405, "Use the sign-out button", "Signing out needs the button on the account page.");
    if (!sameOrigin(req, env)) return authMessage(env, 403, "Rejected", "Cross-site requests aren't accepted.");
    const tok = cookies(req).get(SESSION_COOKIE);
    if (tok) await env.DB.prepare("DELETE FROM sessions WHERE id = ?1").bind(await sha256hex(tok)).run();
    const form = await req.formData().catch(() => null);
    return redirect303(safeNext(form?.get("next")?.toString()), clearCookies());
  }

  return authMessage(env, 404, "Not found", "There's nothing here.");
}

// ---------------------------------------------------------------------------------------------
// display names and links (edited on /account)

export const NAME_MAX = 40;
const cleanName = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim();

/** Why a display name can't be used, or null if it can. Checks the shape, the reserved names,
 *  other users' GitHub logins and other users' display names (case-insensitively, after NFKC).
 *  Look-alike letters from other scripts aren't caught; the verified links are the real proof. */
export async function nameProblem(env: Env, userId: string, name: string): Promise<string | null> {
  const n = cleanName(name);
  if (!n) return "Enter a name.";
  if ([...n].length > NAME_MAX) return `Names can be at most ${NAME_MAX} characters.`;
  if (!/^[\p{L}\p{M}\p{N} .'’\-_()]+$/u.test(n)) return "Use letters, digits, spaces and . ' - _ ( ) only.";
  const key = nameKey(n);
  if (key === DELETED_NAME || /^user-[a-z2-7]+$/.test(key)) return "That name is reserved.";
  const [login, taken] = await env.DB.batch([
    env.DB.prepare("SELECT 1 FROM identities WHERE provider = 'github' AND lower(handle) = ?1 AND user_id != ?2").bind(key, userId),
    env.DB.prepare("SELECT 1 FROM users WHERE name_key = ?1 AND id != ?2").bind(key, userId),
  ]);
  if (login.results.length) return "That is someone else’s GitHub username.";
  if (taken.results.length) return "Someone else already uses that name.";
  return null;
}

/** Set a display name (call nameProblem first). Returns the stored, normalized name. */
export async function setDisplayName(env: Env, userId: string, name: string): Promise<string> {
  const n = cleanName(name);
  await env.DB.prepare("UPDATE users SET display_name = ?2, name_key = ?3 WHERE id = ?1").bind(userId, n, nameKey(n)).run();
  return n;
}

export interface UserLink {
  label: string;
  url: string;
}
export const MAX_LINKS = 5;

export async function userLinks(env: Env, userId: string): Promise<UserLink[]> {
  const r = await env.DB.prepare("SELECT label, url FROM user_links WHERE user_id = ?1 ORDER BY position").bind(userId).all<UserLink>();
  return r.results;
}

/** Replace a user's self-reported links. Each must be http(s); a missing label becomes the host. */
export async function setUserLinks(env: Env, userId: string, links: UserLink[]): Promise<string | null> {
  const clean: UserLink[] = [];
  for (const l of links) {
    const raw = l.url.trim();
    if (!raw) continue;
    let u: URL;
    try {
      u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return `“${raw.slice(0, 60)}” isn’t a valid link.`;
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || raw.length > 300) return `“${raw.slice(0, 60)}” isn’t a web link.`;
    const label = (cleanName(l.label) || u.hostname.replace(/^www\./, "")).slice(0, 40);
    clean.push({ label, url: u.toString() });
  }
  if (clean.length > MAX_LINKS) return `At most ${MAX_LINKS} links.`;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user_links WHERE user_id = ?1").bind(userId),
    ...clean.map((l, i) =>
      env.DB.prepare("INSERT INTO user_links (user_id, position, label, url) VALUES (?1, ?2, ?3, ?4)").bind(userId, i, l.label, l.url),
    ),
  ]);
  return null;
}

// ---------------------------------------------------------------------------------------------
// public profiles (safe to render into publicly cached pages)

export interface PublicProfile {
  id: string;
  displayName: string;
  role: Role;
  kind: Kind;
  owner?: { id: string; displayName: string };
  banned: boolean;
  deleted: boolean;
  createdAt: string;
  identities: Identity[]; // public ones only
  links: UserLink[]; // self-reported, unverified
}

/** Public profiles for many users at once (comment threads, upload credits). Unknown ids are
 *  left out; deleted users come back as tombstones ("deleted user", no identities or links). */
export async function publicProfiles(env: Env, userIds: string[]): Promise<Map<string, PublicProfile>> {
  const out = new Map<string, PublicProfile>();
  const ids = [...new Set(userIds)];
  if (!ids.length) return out;
  const list = JSON.stringify(ids);
  const [us, is, ls] = await env.DB.batch([
    env.DB.prepare(
      `SELECT u.id, u.display_name, u.role, u.kind, u.owner_user_id, o.display_name AS owner_name, u.banned, u.deleted_at,
         u.created_at FROM users u LEFT JOIN users o ON o.id = u.owner_user_id WHERE u.id IN (SELECT value FROM json_each(?1))`,
    ).bind(list),
    env.DB.prepare(
      "SELECT * FROM identities WHERE public = 1 AND user_id IN (SELECT value FROM json_each(?1)) ORDER BY provider, created_at",
    ).bind(list),
    env.DB.prepare("SELECT user_id, label, url FROM user_links WHERE user_id IN (SELECT value FROM json_each(?1)) ORDER BY position").bind(list),
  ]);
  for (const r of us.results as unknown as (UserRow & { created_at: string })[]) {
    const deleted = !!r.deleted_at;
    out.set(r.id, {
      id: r.id,
      displayName: deleted ? DELETED_NAME : r.display_name,
      role: r.role,
      kind: r.kind,
      ...(r.owner_user_id && !deleted ? { owner: { id: r.owner_user_id, displayName: r.owner_name ?? DELETED_NAME } } : {}),
      banned: !!r.banned,
      deleted,
      createdAt: r.created_at,
      identities: [],
      links: [],
    });
  }
  for (const r of is.results as unknown as IdentityRow[]) {
    const p = out.get(r.user_id);
    if (p && !p.deleted) p.identities.push(toIdentity(r));
  }
  for (const r of ls.results as unknown as (UserLink & { user_id: string })[]) {
    const p = out.get(r.user_id);
    if (p && !p.deleted) p.links.push({ label: r.label, url: r.url });
  }
  return out;
}

/** Is this GitHub numeric id a public identity of a live, unbanned user? (For /avatar.) */
export async function publicGithubId(env: Env, githubId: string): Promise<boolean> {
  if (!/^\d{1,12}$/.test(githubId)) return false;
  const r = await env.DB.prepare(
    `SELECT 1 FROM identities i JOIN users u ON u.id = i.user_id
     WHERE i.provider = 'github' AND i.provider_user_id = ?1 AND i.public = 1 AND u.banned = 0 AND u.deleted_at IS NULL`,
  )
    .bind(githubId)
    .first();
  return !!r;
}
