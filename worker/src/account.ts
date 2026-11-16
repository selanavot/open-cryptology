// /account: the log-in page when logged out; when logged in, an account settings page (name,
// log-in methods, sessions, danger zone), and /account/merge. Never cached. Data access lives in
// auth.ts. Internal user ids never appear on these pages.
import type { Env } from "./db";
import { html, type Html } from "./html";
import { messagePage, page } from "./layout";
import {
  type Actor,
  type Identity,
  type MergeOffer,
  type Provider,
  type User,
  clearCookies,
  clearMergeCookie,
  currentUser,
  deleteAccount,
  devLogin,
  dropMerge,
  LOGIN_COOKIE,
  loadUser,
  loginCookie,
  mergeAccounts,
  NAME_MAX,
  nameProblem,
  nameFromIds,
  pendingMerge,
  PERSONAL_DOMAINS,
  PROVIDER_LABEL,
  redirect303,
  safeNext,
  sameOrigin,
  setCustomName,
} from "./auth";
import { siteOrigin } from "./seo";
import { cleanLabel, LABEL_MAX, mintToken, revokeToken, tokenExpires, TOKEN_IDLE_DAYS, tokensOf, type TokenRow } from "./agentapi";

export const isAccountPath = (path: string): boolean => path === "/account" || path === "/account/merge";

const NO_STORE = { cache: "no-store", noindex: true } as const;
const PROVIDERS: Provider[] = ["github", "google", "orcid"];

// ---------------------------------------------------------------------------------------------
// small pieces

const initials = (name: string): string => {
  const w = name.trim().split(/\s+/);
  const first = [...(w[0] ?? "?")][0] ?? "?";
  const last = w.length > 1 ? ([...w[w.length - 1]][0] ?? "") : "";
  return (first + last).toUpperCase();
};

/** A round profile photo, or the person's initials when there is none. */
export function avatar(u: Pick<User, "displayName" | "avatar">, cls = ""): Html {
  return u.avatar
    ? html`<img class="avatar ${cls}" src="${u.avatar}" alt="" referrerpolicy="no-referrer">`
    : html`<span class="avatar ${cls}" aria-hidden="true">${initials(u.displayName)}</span>`;
}

/** What a log-in method shows: a link for GitHub and ORCID; for Google, the email's domain when
 *  it is an institution's ("verified @mit.edu"). */
export function identityDetail(i: Identity): Html {
  if (i.provider === "google") return html`<span>${PERSONAL_DOMAINS.has(i.handle) ? "Google account" : html`verified @${i.handle}`}</span>`;
  return html`<a href="${i.url}" rel="noopener">${i.handle}</a>`;
}

/** Provider marks for log-in buttons and rows: GitHub's Octicons mark (MIT), Google's "G" and
 *  ORCID's iD icon as their sign-in brand guidelines give them. */
const PROVIDER_ICON: Record<Provider, Html> = {
  github: html`<svg class="provider-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="#24292f" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`,
  google: html`<svg class="provider-icon" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`,
  orcid: html`<svg class="provider-icon" viewBox="0 0 256 256" aria-hidden="true" focusable="false"><path fill="#A6CE39" d="M256 128c0 70.7-57.3 128-128 128S0 198.7 0 128 57.3 0 128 0s128 57.3 128 128z"/><path fill="#fff" d="M86.3 186.2H70.9V79.1h15.4v107.1zM108.9 79.1h41.6c39.6 0 57 28.3 57 53.6 0 27.5-21.5 53.6-56.8 53.6h-41.8V79.1zm15.4 93.3h24.5c34.9 0 42.9-26.5 42.9-39.7C191.7 111.2 178 93 148 93h-23.7v79.4zM88.7 56.8c0 5.5-4.5 10.1-10.1 10.1s-10.1-4.6-10.1-10.1c0-5.6 4.5-10.1 10.1-10.1s10.1 4.6 10.1 10.1z"/></svg>`,
};

/** Icon + name, e.g. for a row label. */
export const providerTag = (p: Provider): Html => html`<span class="provider-tag">${PROVIDER_ICON[p]}${PROVIDER_LABEL[p]}</span>`;

const pencil = html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M11.2 2.3l2.5 2.5-8.1 8.1-3.1.6.6-3.1z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.6 3.9l2.5 2.5" stroke="currentColor" stroke-width="1.3"/></svg>`;

/** Where a log-in button points: the real provider when configured, else (local test server
 *  only) a made-up account. Null when neither is available. */
function providerHref(env: Env, p: Provider, next: string, link: boolean): string | null {
  const n = encodeURIComponent(next);
  const l = link ? "link=1&" : "";
  const real = { github: env.GITHUB_CLIENT_ID, google: env.GOOGLE_CLIENT_ID, orcid: env.ORCID_CLIENT_ID }[p];
  if (real) return `/auth/${p}?${l}next=${n}`;
  if (!devLogin(env)) return null;
  if (p === "github") return `/auth/dev-login?${l}login=dev-user&ghid=1&name=Ada%20Lovelace&next=${n}`;
  if (p === "google") return `/auth/dev-google?${l}sub=1&email=dev%40example.edu&name=Ada%20Lovelace&next=${n}`;
  return `/auth/dev-orcid?${l}orcid=0000-0002-1825-0097&name=Ada%20Lovelace&next=${n}`;
}

function settingsPage(env: Env, title: string, body: Html, status = 200): Response {
  return page(env, { title, status, ...NO_STORE, body: html`<div class="settings">${body}</div>` });
}

// ---------------------------------------------------------------------------------------------
// log in

function logInPage(env: Env, url: URL): Response {
  const next = safeNext(url.searchParams.get("next") ?? "/account");
  const buttons = PROVIDERS.map((p) => [p, providerHref(env, p, next, false)] as const).filter(([, h]) => h);
  return settingsPage(
    env,
    "Log in",
    html`<section class="settings-card settings-login">
  <h1 class="settings-title">Log in to ${env.SITE_NAME}</h1>
  ${buttons.length
    ? html`<div class="login-buttons">${buttons.map(([p, h]) => html`<a class="btn btn-outline-dark" href="${h}">${PROVIDER_ICON[p]}<span>Continue with ${PROVIDER_LABEL[p]}</span></a>`)}</div>
  ${devLogin(env) && html`<p class="settings-hint">Local test server: unconfigured providers use made-up accounts.</p>`}`
    : html`<p class="settings-hint">Logging in isn’t switched on yet.</p>`}
  <p class="settings-fine"><a href="/privacy">Privacy</a></p>
</section>`,
  );
}

// ---------------------------------------------------------------------------------------------
// account settings

const SAVED: Record<string, string> = {
  merged: "Accounts merged.",
  "merge-cancelled": "Nothing was merged.",
  name: "Name saved.",
  "name-reset": "Name reset.",
  linked: "Connected.",
  "agent-disconnected": "Agent disconnected.",
};

interface Notice {
  ok?: string;
  err?: string;
}

/** What the Agents card shows: the connected agents, and a token just made (shown once). */
interface Agents {
  tokens: TokenRow[];
  made?: { label: string; token: string };
}

const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function agentsCard(env: Env, ag: Agents): Html {
  return html`<section class="settings-card" id="agents">
  <h2 class="settings-h">Agents</h2>
  <p class="settings-hint">Let an AI agent post original manuscripts as you. Each agent gets its own token, which can post and read
  manuscripts but can’t change your account. A token stops working after ${TOKEN_IDLE_DAYS} days without use.</p>
  ${ag.made &&
  html`<div class="agent-made" role="status">
    <p class="mb-1"><strong>Token for “${ag.made.label}”.</strong> Copy it now: it won’t be shown again.</p>
    <div class="agent-token"><code id="new-token">${ag.made.token}</code>
      <button type="button" class="btn btn-sm btn-outline-dark" data-copy="new-token" aria-label="Copy the token">Copy</button></div>
    <p class="settings-hint mb-0 mt-2">Give it to your agent, for example: “Post my manuscript to Open Cryptology (see
    ${siteOrigin(env, new URL("https://opencryptology.org"))}/llms.txt); my token is in the OC_TOKEN environment variable.”</p>
  </div>`}
  ${ag.tokens.length
    ? html`<ul class="settings-rows">${ag.tokens.map((t) => {
        const expired = tokenExpires(t).getTime() < Date.now();
        return html`<li class="settings-row">
      <span class="settings-row-value"><strong>${t.name}</strong><br><span class="settings-hint">Connected ${shortDate(t.created_at)} ·
        ${expired ? "expired" : t.last_used ? `last used ${shortDate(t.last_used)}` : "not used yet"}</span></span>
      <form method="post" action="/account"><input type="hidden" name="action" value="token-revoke"><input type="hidden" name="token" value="${t.id}">
        <button class="btn btn-sm btn-outline-dark" type="submit">Disconnect</button></form>
    </li>`;
      })}</ul>`
    : ""}
  <details class="agent-new"${ag.tokens.length ? "" : " open"}>
    <summary class="settings-link">Connect an agent</summary>
    <form method="post" action="/account" class="name-form">
      <input type="hidden" name="action" value="token-new">
      <label class="visually-hidden" for="agent-label">Agent name</label>
      <input class="form-control form-control-sm" id="agent-label" name="label" maxlength="${LABEL_MAX}" required placeholder="e.g. Claude Code on my laptop">
      <button class="btn btn-sm btn-outline-dark" type="submit">Create token</button>
    </form>
    <p class="settings-hint mt-2 mb-0">Manuscripts your agents post are published right away under CC BY 4.0 and the
    <a href="/terms">terms</a>, as yours. Disconnecting an agent doesn’t remove what it posted; <a href="/contact?topic=manuscript">write to us</a> for that.</p>
  </details>
</section>`;
}

function accountPage(env: Env, a: Actor, notice: Notice, status: number, agents: Agents): Response {
  const u = a.user;
  const missing = PROVIDERS.filter((p) => !u.identities.some((i) => i.provider === p));
  const order = (i: Identity) => PROVIDERS.indexOf(i.provider);
  return settingsPage(
    env,
    "Account settings",
    html`${notice.ok && html`<p class="settings-notice" role="status">${notice.ok}</p>`}
${notice.err && html`<p class="settings-notice settings-notice-err" role="alert">${notice.err}</p>`}
<header class="settings-head">
  ${avatar(u, "avatar-lg")}
  <div class="settings-who">
    <div class="settings-name-row">
      <h1 class="settings-name">${u.displayName}</h1>
      ${u.role === "maintainer" && html`<span class="settings-badge">maintainer</span>`}
    </div>
    <details class="name-edit"${notice.err && status === 400 ? " open" : ""}>
      <summary class="settings-link">${pencil} Edit name</summary>
      <form method="post" action="/account" class="name-form">
        <input type="hidden" name="action" value="name">
        <label class="visually-hidden" for="name">Name</label>
        <input class="form-control form-control-sm" id="name" name="name" value="${u.displayName}" maxlength="${NAME_MAX * 2}" required autocomplete="name">
        <button class="btn btn-sm btn-outline-dark" type="submit">Save</button>
      </form>
      ${u.customName &&
      html`<form method="post" action="/account" class="name-reset">
        <input type="hidden" name="action" value="name-reset">
        <button class="settings-link" type="submit">Reset to ${nameFromIds(u)}</button>
      </form>`}
    </details>
  </div>
  <form method="post" action="/auth/logout" class="settings-logout"><input type="hidden" name="next" value="/">
    <button class="btn btn-sm btn-outline-dark" type="submit">Log out</button></form>
</header>

<section class="settings-card">
  <h2 class="settings-h">Log-in methods</h2>
  <ul class="settings-rows">
    ${[...u.identities].sort((x, y) => order(x) - order(y)).map(
      (i) => html`<li class="settings-row">
      <span class="settings-row-label">${providerTag(i.provider)}</span>
      <span class="settings-row-value">${identityDetail(i)}</span>
      <span class="settings-row-state">Connected</span>
    </li>`,
    )}
    ${missing.map((p) => {
      const h = providerHref(env, p, "/account", true);
      return html`<li class="settings-row">
      <span class="settings-row-label">${providerTag(p)}</span>
      <span class="settings-row-value text-muted">Not connected</span>
      ${h ? html`<a class="btn btn-sm btn-outline-dark" href="${h}">Connect</a>` : html`<span class="settings-row-state">Not available yet</span>`}
    </li>`;
    })}
  </ul>
</section>

${agentsCard(env, agents)}

${u.role === "maintainer" &&
html`<section class="settings-card">
  <h2 class="settings-h">Maintainer</h2>
  <ul class="settings-rows"><li class="settings-row">
    <span class="settings-row-value">Upload review queue</span>
    <a class="btn btn-sm btn-outline-dark" href="/review">Open</a>
  </li></ul>
</section>`}

<section class="settings-card settings-danger">
  <h2 class="settings-h">Danger zone</h2>
  <div class="settings-row settings-row-top">
    <div class="settings-row-value">
      <strong>Delete this account</strong>
      <p class="settings-hint mb-0">Your posts stay, credited to “deleted user”. Can’t be undone.</p>
    </div>
    <details class="danger-confirm">
      <summary class="btn btn-sm btn-danger-outline">Delete account…</summary>
      <form method="post" action="/account" class="danger-form">
        <input type="hidden" name="action" value="delete">
        <label class="acct-check"><input type="checkbox" name="confirm" value="yes" required> Yes, delete my account</label>
        <button class="btn btn-sm btn-danger-outline" type="submit">Delete forever</button>
      </form>
    </details>
  </div>
</section>`,
    status,
  );
}

async function renderAccount(env: Env, a: Actor, notice: Notice, status = 200, made?: Agents["made"]): Promise<Response> {
  return accountPage(env, a, notice, status, { tokens: await tokensOf(env, a.user.id), made });
}

/** /account/merge: the log-in method just connected belongs to another account; merge it in? */
function mergePage(env: Env, a: Actor, m: MergeOffer): Response {
  const who = (u: User, label: string) => html`<div class="merge-side">
    <p class="settings-kicker">${label}</p>
    <div class="merge-who">${avatar(u)}<strong>${u.displayName}</strong></div>
    <ul class="settings-rows">${u.identities.map(
      (i) => html`<li class="settings-row"><span class="settings-row-label">${providerTag(i.provider)}</span><span class="settings-row-value">${identityDetail(i)}</span></li>`,
    )}</ul>
  </div>`;
  const via = PROVIDER_LABEL[m.via.provider];
  return settingsPage(
    env,
    "Merge accounts?",
    html`<section class="settings-card">
  <h1 class="settings-title">Merge accounts?</h1>
  <p>This ${via} account already belongs to another account here.</p>
  <div class="merge-grid">
    ${who(a.user, "This account")}
    ${who(m.other, "Other account")}
  </div>
  <p class="settings-hint">Merging combines them into one account. Can’t be undone.</p>
  <div class="settings-actions">
    <form method="post" action="/account"><input type="hidden" name="action" value="merge">
      <button class="btn btn-sm btn-outline-dark" type="submit">Merge accounts</button></form>
    <form method="post" action="/account"><input type="hidden" name="action" value="merge-cancel">
      <button class="btn btn-sm btn-link" type="submit">Cancel</button></form>
  </div>
</section>`,
  );
}

// ---------------------------------------------------------------------------------------------
// routes

async function accountPost(env: Env, req: Request): Promise<Response> {
  if (!sameOrigin(req, env)) return messagePage(env, 403, "Rejected", html`<p>Cross-site requests aren’t accepted.</p>`, NO_STORE);
  const a = await currentUser(env, req);
  if (!a) return redirect303("/account");
  const form = await req.formData();
  const action = form.get("action")?.toString();
  const withCookie = async (saved: string) => {
    const u = await loadUser(env, a.user.id);
    return redirect303(`/account?saved=${saved}`, u ? [loginCookie(u)] : []);
  };
  if (action === "delete") {
    if (form.get("confirm") !== "yes") return renderAccount(env, a, { err: "Tick the box to confirm." }, 422);
    await deleteAccount(env, a.user.id);
    return redirect303("/?account=deleted", clearCookies());
  }
  if (action === "merge" || action === "merge-cancel") {
    const m = await pendingMerge(env, req, a.user.id);
    if (!m) return renderAccount(env, a, { err: "That merge expired. Connect the account again to start over." }, 410);
    if (action === "merge-cancel") {
      await dropMerge(env, m.id);
      return redirect303("/account?saved=merge-cancelled", [clearMergeCookie]);
    }
    await mergeAccounts(env, a.user.id, m.other.id, m.id);
    const u = await loadUser(env, a.user.id);
    return redirect303("/account?saved=merged", [clearMergeCookie, ...(u ? [loginCookie(u)] : [])]);
  }
  if (action === "token-new") {
    const label = cleanLabel(form.get("label"));
    if (!label) return renderAccount(env, a, { err: "Name the agent, so you can tell your tokens apart." }, 400);
    if ((await tokensOf(env, a.user.id)).length >= 20) return renderAccount(env, a, { err: "You have 20 agents connected. Disconnect one first." }, 400);
    const t = await mintToken(env, a.user.id, label);
    // Shown on this response only (never in a URL or a redirect), so it isn't cached or logged.
    return renderAccount(env, a, {}, 200, { label, token: t.token });
  }
  if (action === "token-revoke") {
    const ok = await revokeToken(env, a.user.id, form.get("token")?.toString() ?? "");
    return ok ? redirect303("/account?saved=agent-disconnected#agents") : renderAccount(env, a, { err: "That agent was already disconnected." }, 404);
  }
  if (action === "name") {
    const name = form.get("name")?.toString() ?? "";
    const problem = nameProblem(name);
    if (problem) return renderAccount(env, a, { err: problem }, 400);
    await setCustomName(env, a.user.id, name);
    return withCookie("name");
  }
  if (action === "name-reset") {
    await setCustomName(env, a.user.id, null);
    return withCookie("name-reset");
  }
  return renderAccount(env, a, { err: "Unknown action." }, 400);
}

export async function handleAccount(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method === "POST") return accountPost(env, req);
  if (req.method !== "GET" && req.method !== "HEAD") return messagePage(env, 405, "Method not allowed", html`<p>Use the forms on this page.</p>`, NO_STORE);
  const a = await currentUser(env, req);
  if (!a) {
    const res = logInPage(env, url);
    // The session expired (or was revoked) but the navbar's display cookie remains: clear it.
    if (req.headers.get("cookie")?.includes(`${LOGIN_COOKIE}=`)) res.headers.append("set-cookie", `${LOGIN_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Lax`);
    return res;
  }
  if (url.pathname === "/account/merge") {
    const m = await pendingMerge(env, req, a.user.id);
    return m ? mergePage(env, a, m) : redirect303("/account");
  }
  return renderAccount(env, a, { ok: SAVED[url.searchParams.get("saved") ?? ""] });
}
