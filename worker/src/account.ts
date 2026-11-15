// /account: the sign-in page when signed out; when signed in, your display name, your sign-ins
// (add or remove GitHub, Google, ORCID), sign out, and deleting the account. Never cached.
// Data access lives in auth.ts.
import type { Env } from "./db";
import { html, type Html } from "./html";
import { card, messagePage, page } from "./layout";
import {
  type Actor,
  type Identity,
  type Provider,
  clearCookies,
  currentUser,
  deleteAccount,
  devLogin,
  LOGIN_COOKIE,
  loginCookie,
  NAME_MAX,
  nameProblem,
  PERSONAL_DOMAINS,
  PROVIDER_LABEL,
  redirect303,
  removeIdentity,
  safeNext,
  sameOrigin,
  setDisplayName,
  signOutOthers,
} from "./auth";

export const isAccountPath = (path: string): boolean => path === "/account";

const NO_STORE = { cache: "no-store", noindex: true } as const;
const PROVIDERS: Provider[] = ["github", "google", "orcid"];

/** One verified identity: a link for GitHub and ORCID; for Google, the email's domain when it is
 *  an institution's ("verified @mit.edu"), since Google accounts have no public page. */
export function identityLink(i: Identity): Html {
  const kind = html`<span class="ident-kind">${PROVIDER_LABEL[i.provider]}</span>`;
  if (i.provider === "google")
    return html`<span class="ident">${kind} ${PERSONAL_DOMAINS.has(i.handle) ? "account" : html`verified @${i.handle}`}</span>`;
  return html`<span class="ident">${kind} <a href="${i.url}" rel="noopener">${i.handle}</a></span>`;
}

/** Where a sign-in button points: the real provider when configured, else (local test server
 *  only) a made-up account. Null when neither is available. */
function providerHref(env: Env, p: Provider, next: string, link: boolean): string | null {
  const n = encodeURIComponent(next);
  const l = link ? "link=1&" : "";
  const real = { github: env.GITHUB_CLIENT_ID, google: env.GOOGLE_CLIENT_ID, orcid: env.ORCID_CLIENT_ID }[p];
  if (real) return `/auth/${p}?${l}next=${n}`;
  if (!devLogin(env)) return null;
  if (p === "github") return `/auth/dev-login?${l}login=dev-user&ghid=1&next=${n}`;
  if (p === "google") return `/auth/dev-google?${l}sub=1&email=dev%40example.edu&name=Dev%20User&next=${n}`;
  return `/auth/dev-orcid?${l}orcid=0000-0002-1825-0097&name=Dev%20User&next=${n}`;
}

function signInPage(env: Env, url: URL): Response {
  const next = safeNext(url.searchParams.get("next") ?? "/account");
  const buttons = PROVIDERS.map((p) => [p, providerHref(env, p, next, false)] as const).filter(([, h]) => h);
  return page(env, {
    title: "Sign in",
    ...NO_STORE,
    body: card(
      "Sign in",
      html`<p>Sign in with any of these. You can add the others afterwards and sign in with any of them.</p>
${buttons.length
  ? html`<p class="acct-signin">${buttons.map(([p, h]) => html`<a class="btn btn-outline-dark" href="${h}">Sign in with ${PROVIDER_LABEL[p]}</a>`)}</p>
${devLogin(env) && html`<p class="text-muted">Local test server: buttons without a configured app sign in as made-up accounts.</p>`}`
  : html`<p class="text-muted">Sign-in isn’t switched on yet.</p>`}
<p class="form-hint text-muted">We keep the account’s id and public name (GitHub username, ORCID iD, or your Google
address’s domain). We never see your password or get access to your repositories or records.
<a href="/privacy">Privacy</a></p>`,
      "account",
    ),
  });
}

function identitiesBody(env: Env, u: Actor["user"]): Html {
  const have = new Set(u.identities.map((i) => i.provider));
  const add = PROVIDERS.filter((p) => !have.has(p)).map((p) => [p, providerHref(env, p, "/account", true)] as const).filter(([, h]) => h);
  return html`<p class="text-muted">You can sign in with any of these. They’re shown next to your name.</p>
<ul class="acct-list acct-idents">${u.identities.map(
    (i) => html`<li><form method="post" action="/account" class="acct-inline">
  <input type="hidden" name="action" value="identity">
  <input type="hidden" name="provider" value="${i.provider}"><input type="hidden" name="pid" value="${i.providerUserId}">
  ${identityLink(i)}
  ${u.identities.length > 1 && html`<button class="btn btn-sm btn-outline-dark" name="change" value="remove">Remove</button>`}
</form></li>`,
  )}</ul>
${add.length > 0 &&
  html`<p class="mt-2 acct-signin">${add.map(([p, h]) => html`<a class="btn btn-sm btn-outline-dark" href="${h}">Add ${PROVIDER_LABEL[p]}</a>`)}</p>`}`;
}

const SAVED: Record<string, string> = {
  name: "Your name was saved.",
  linked: "The account was added. You can sign in with it too.",
  identity: "The sign-in was removed, and your other browsers were signed out.",
  sessions: "Your other browsers were signed out.",
};

interface Notice {
  ok?: string;
  err?: string;
}

function accountPage(env: Env, a: Actor, notice: Notice, status = 200): Response {
  const u = a.user;
  const body = html`${notice.ok && html`<p class="upload-notice upload-notice-ok" role="status">${notice.ok}</p>`}
${notice.err && html`<p class="upload-notice upload-notice-err" role="alert">${notice.err}</p>`}
${card(
  "Your account",
  html`<p>Signed in as <strong>${u.displayName}</strong>${u.role === "maintainer" && html` <small class="badge acct-badge">maintainer</small>`}</p>
<form method="post" action="/account" class="acct-form">
  <input type="hidden" name="action" value="name">
  <label class="form-label mb-1" for="name">Display name</label>
  <div class="input-group">
    <input class="form-control form-control-sm" id="name" name="name" value="${u.displayName}" maxlength="${NAME_MAX * 2}" required autocomplete="nickname">
    <button class="btn btn-sm btn-outline-dark" type="submit">Save</button>
  </div>
  <p class="form-hint text-muted">Shown next to everything you post, together with your sign-ins.</p>
</form>`,
  "account",
)}
${card("Sign-ins", identitiesBody(env, u), "account")}
${card(
  "Delete your account",
  html`<p>This signs you out everywhere, removes your sign-ins and frees your name. What you posted stays,
credited to “deleted user”. It can’t be undone.</p>
<form method="post" action="/account" class="acct-form">
  <input type="hidden" name="action" value="delete">
  <label class="acct-check"><input type="checkbox" name="confirm" value="yes" required> I understand, delete my account</label>
  <button class="btn btn-sm btn-outline-dark" type="submit">Delete account</button>
</form>`,
  "account",
)}
<div class="acct-signout">
<form method="post" action="/auth/logout" class="acct-inline">
  <input type="hidden" name="next" value="/">
  <button class="btn btn-sm btn-outline-dark" type="submit">Sign out</button>
</form>
<form method="post" action="/account" class="acct-inline">
  <input type="hidden" name="action" value="sessions">
  <button class="btn btn-sm btn-outline-dark" type="submit">Sign out other browsers</button>
</form>
</div>`;
  return page(env, { title: "Your account", status, ...NO_STORE, body });
}

async function accountPost(env: Env, req: Request): Promise<Response> {
  if (!sameOrigin(req, env)) return messagePage(env, 403, "Rejected", html`<p>Cross-site requests aren’t accepted.</p>`, NO_STORE);
  const a = await currentUser(env, req);
  if (!a) return redirect303("/account");
  const form = await req.formData();
  const action = form.get("action")?.toString();
  if (action === "delete") {
    if (form.get("confirm") !== "yes") return accountPage(env, a, { err: "Tick the box to confirm." }, 400);
    await deleteAccount(env, a.user.id);
    return redirect303("/?account=deleted", clearCookies());
  }
  if (action === "identity") {
    if (form.get("change") !== "remove") return accountPage(env, a, { err: "Unknown change." }, 400);
    const problem = await removeIdentity(env, a.user, form.get("provider")?.toString() ?? "", form.get("pid")?.toString() ?? "", a.sessionId);
    return problem ? accountPage(env, a, { err: problem }, 400) : redirect303("/account?saved=identity");
  }
  if (action === "sessions") {
    await signOutOthers(env, a.user.id, a.sessionId);
    return redirect303("/account?saved=sessions");
  }
  if (action === "name") {
    const name = form.get("name")?.toString() ?? "";
    const problem = await nameProblem(env, a.user.id, name);
    if (problem) return accountPage(env, a, { err: problem }, 400);
    const stored = await setDisplayName(env, a.user.id, name);
    return redirect303("/account?saved=name", [loginCookie(stored)]);
  }
  return accountPage(env, a, { err: "Unknown action." }, 400);
}

export async function handleAccount(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method === "POST") return accountPost(env, req);
  if (req.method !== "GET" && req.method !== "HEAD") return messagePage(env, 405, "Method not allowed", html`<p>Use the forms on this page.</p>`, NO_STORE);
  const a = await currentUser(env, req);
  if (!a) {
    const res = signInPage(env, url);
    // The session expired (or was revoked) but the navbar's display cookie remains: clear it.
    if (req.headers.get("cookie")?.includes(`${LOGIN_COOKIE}=`)) res.headers.append("set-cookie", `${LOGIN_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Lax`);
    return res;
  }
  return accountPage(env, a, { ok: SAVED[url.searchParams.get("saved") ?? ""] });
}
