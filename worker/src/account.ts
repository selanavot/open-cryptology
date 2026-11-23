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
import { loginButtons, PROVIDER_ICON, PROVIDERS, providerHref } from "./login";

export const isAccountPath = (path: string): boolean => path === "/account" || path === "/account/merge";

const NO_STORE = { cache: "no-store", noindex: true } as const;

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

/** Icon + name, e.g. for a row label. */
export const providerTag = (p: Provider): Html => html`<span class="provider-tag">${PROVIDER_ICON[p]}${PROVIDER_LABEL[p]}</span>`;

const pencil = html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M11.2 2.3l2.5 2.5-8.1 8.1-3.1.6.6-3.1z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.6 3.9l2.5 2.5" stroke="currentColor" stroke-width="1.3"/></svg>`;
const check = html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const chevron = html`<svg class="acct-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3.5l4.5 4.5L6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function settingsPage(env: Env, title: string, body: Html, status = 200): Response {
  return page(env, { title, status, ...NO_STORE, body: html`<div class="settings">${body}</div>` });
}

// ---------------------------------------------------------------------------------------------
// log in

function logInPage(env: Env, url: URL): Response {
  const next = safeNext(url.searchParams.get("next") ?? "/account");
  const buttons = loginButtons(env, next);
  return settingsPage(
    env,
    "Log in",
    html`<section class="settings-card settings-login">
  <h1 class="settings-title">Log in or create an account</h1>
  ${buttons
    ? html`${buttons}
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
};

interface Notice {
  ok?: string;
  err?: string;
}

function accountPage(env: Env, a: Actor, notice: Notice, status = 200): Response {
  const u = a.user;
  const missing = PROVIDERS.filter((p) => !u.identities.some((i) => i.provider === p));
  const order = (i: Identity) => PROVIDERS.indexOf(i.provider);
  return settingsPage(
    env,
    "Account settings",
    html`${notice.ok && html`<p class="settings-notice" role="status">${notice.ok}</p>`}
${notice.err && html`<p class="settings-notice settings-notice-err" role="alert">${notice.err}</p>`}
<header class="settings-head acct-head">
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

<section class="acct-section">
  <h2 class="acct-h">Log-in methods</h2>
  <ul class="acct-card">
    ${[...u.identities].sort((x, y) => order(x) - order(y)).map(
      (i) => html`<li class="acct-row">
      <span class="acct-tile">${PROVIDER_ICON[i.provider]}</span>
      <span class="acct-main"><span class="acct-label">${PROVIDER_LABEL[i.provider]}</span><span class="acct-sub">${identityDetail(i)}</span></span>
      <span class="acct-state">${check} Connected</span>
    </li>`,
    )}
    ${missing.map((p) => {
      const h = providerHref(env, p, "/account", true);
      return html`<li class="acct-row">
      <span class="acct-tile">${PROVIDER_ICON[p]}</span>
      <span class="acct-main"><span class="acct-label">${PROVIDER_LABEL[p]}</span><span class="acct-sub">Not connected</span></span>
      ${h ? html`<a class="btn btn-sm btn-outline-dark" href="${h}">Connect</a>` : html`<span class="acct-sub">Not available yet</span>`}
    </li>`;
    })}
  </ul>
</section>

${u.role === "maintainer" &&
html`<section class="acct-section">
  <h2 class="acct-h">Maintainer</h2>
  <div class="acct-card">
    <a class="acct-row acct-link" href="/account/bots"><span class="acct-main"><span class="acct-label">Manage bot accounts</span></span>${chevron}</a>
    <a class="acct-row acct-link" href="/review"><span class="acct-main"><span class="acct-label">Upload review queue</span></span>${chevron}</a>
  </div>
</section>`}

<section class="acct-section">
  <h2 class="acct-h">Delete account</h2>
  <div class="acct-card">
    <div class="acct-row acct-row-top">
      <span class="acct-main"><span class="acct-sub">Your posts stay, credited to “deleted user”. Can’t be undone.</span></span>
      <details class="danger-confirm">
        <summary class="btn btn-sm btn-danger-outline">Delete account…</summary>
        <form method="post" action="/account" class="danger-form">
          <input type="hidden" name="action" value="delete">
          <label class="acct-check"><input type="checkbox" name="confirm" value="yes" required> Yes, delete my account</label>
          <button class="btn btn-sm btn-danger-outline" type="submit">Delete forever</button>
        </form>
      </details>
    </div>
  </div>
</section>`,
    status,
  );
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
    if (form.get("confirm") !== "yes") return accountPage(env, a, { err: "Tick the box to confirm." }, 422);
    await deleteAccount(env, a.user.id);
    return redirect303("/?account=deleted", clearCookies());
  }
  if (action === "merge" || action === "merge-cancel") {
    const m = await pendingMerge(env, req, a.user.id);
    if (!m) return accountPage(env, a, { err: "That merge expired. Connect the account again to start over." }, 410);
    if (action === "merge-cancel") {
      await dropMerge(env, m.id);
      return redirect303("/account?saved=merge-cancelled", [clearMergeCookie]);
    }
    await mergeAccounts(env, a.user.id, m.other.id, m.id);
    const u = await loadUser(env, a.user.id);
    return redirect303("/account?saved=merged", [clearMergeCookie, ...(u ? [loginCookie(u)] : [])]);
  }
  if (action === "name") {
    const name = form.get("name")?.toString() ?? "";
    const problem = nameProblem(name);
    if (problem) return accountPage(env, a, { err: problem }, 400);
    await setCustomName(env, a.user.id, name);
    return withCookie("name");
  }
  if (action === "name-reset") {
    await setCustomName(env, a.user.id, null);
    return withCookie("name-reset");
  }
  return accountPage(env, a, { err: "Unknown action." }, 400);
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
  return accountPage(env, a, { ok: SAVED[url.searchParams.get("saved") ?? ""] });
}
