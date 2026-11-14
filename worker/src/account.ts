// Account pages: /account (your settings; no-store) and /u/<id> (public profile; cached like
// paper pages). Data access lives in auth.ts.
import type { Env } from "./db";
import { html, type Html, type Val } from "./html";
import { card, messagePage, page } from "./layout";
import { day } from "./pages";
import {
  type Actor,
  type Identity,
  type PublicProfile,
  isAuthFailure,
  loginCookie,
  MAX_LINKS,
  NAME_MAX,
  nameProblem,
  publicProfiles,
  redirect303,
  requireUser,
  safeNext,
  setDisplayName,
  setUserLinks,
  userLinks,
  currentUser,
  type UserLink,
} from "./auth";

const PROFILE_RE = /^\/u\/([a-z2-7]{12})\/?$/;
export const isAccountPath = (path: string): boolean => path === "/account" || PROFILE_RE.test(path);

const NO_STORE = { cache: "no-store", noindex: true } as const;
const year = (iso?: string) => (iso ? iso.slice(0, 4) : "");

/** One verified identity, as a link (the proof behind a display name). */
export function identityLink(i: Identity): Html {
  if (i.provider === "github")
    return html`<span class="ident"><span class="ident-kind">GitHub</span> <a href="${i.url}" rel="noopener">${i.handle}</a>${
      i.providerCreatedAt ? html` <span class="text-muted">· on GitHub since ${year(i.providerCreatedAt)}</span>` : ""
    }</span>`;
  return html`<span class="ident"><span class="ident-kind">ORCID</span> <a href="${i.url}" rel="noopener">${i.handle}</a></span>`;
}

const roleBadge = (p: { role: string; kind: string }): Val =>
  [
    p.kind === "bot" && html`<small class="badge acct-badge">bot</small>`,
    p.role === "maintainer" && html`<small class="badge acct-badge">maintainer</small>`,
  ];

// ---------------------------------------------------------------------------------------------
// /u/<id>

async function profilePage(env: Env, id: string): Promise<Response> {
  const p = (await publicProfiles(env, [id])).get(id);
  if (!p) return messagePage(env, 404, "No such account", html`<p>There’s no account with this address.</p>`);
  if (p.deleted) return messagePage(env, 410, "Deleted account", html`<p>This account was deleted. What it posted stays, credited to “deleted user”.</p>`);
  return page(env, {
    title: p.displayName,
    noindex: true,
    cache: "public, max-age=600",
    body: card(p.displayName, profileBody(p), "profile"),
  });
}

function profileBody(p: PublicProfile): Html {
  return html`<p class="profile-meta">${roleBadge(p)} Joined <time datetime="${p.createdAt}">${day(p.createdAt)}</time></p>
${p.banned && html`<p class="alert alert-warning">This account is suspended.</p>`}
${p.owner && html`<p>An automated account, operated by <a href="/u/${p.owner.id}">${p.owner.displayName}</a>. What it posts is labelled agent-made.</p>`}
${p.identities.length
  ? html`<h4 class="acct-h">Verified</h4>
<ul class="acct-list">${p.identities.map((i) => html`<li>${identityLink(i)}</li>`)}</ul>`
  : ""}
${p.links.length
  ? html`<h4 class="acct-h">Links <span class="unverified">(self-reported, unverified)</span></h4>
<ul class="acct-list">${p.links.map((l) => html`<li><a href="${l.url}" rel="nofollow ugc noopener">${l.label}</a></li>`)}</ul>`
  : ""}`;
}

// ---------------------------------------------------------------------------------------------
// /account

const SAVED: Record<string, string> = {
  name: "Your name was saved.",
  links: "Your links were saved.",
};

function signInPage(env: Env, url: URL): Response {
  const next = safeNext(url.searchParams.get("next") ?? "/account");
  const ready = !!env.GITHUB_CLIENT_ID;
  return page(env, {
    title: "Sign in",
    ...NO_STORE,
    body: card(
      "Sign in",
      html`<p>Sign in to comment and to share results, under your own name or as an agent you run.
We keep your GitHub account’s id and username, and nothing else: no email address, no password, no access to your repositories.</p>
${ready
  ? html`<p><a class="btn btn-outline-dark" href="/auth/github?next=${encodeURIComponent(next)}">Sign in with GitHub</a></p>`
  : html`<p class="text-muted">Sign-in isn’t switched on yet.</p>`}`,
      "account",
    ),
  });
}

interface Notice {
  ok?: string;
  err?: string;
}

async function accountPage(env: Env, a: Actor, notice: Notice, status = 200): Promise<Response> {
  const u = a.user;
  const links = await userLinks(env, u.id);
  const rows: UserLink[] = [...links, ...Array(Math.max(0, MAX_LINKS - links.length)).fill({ label: "", url: "" })].slice(0, MAX_LINKS);
  const body = html`${notice.ok && html`<p class="upload-notice upload-notice-ok" role="status">${notice.ok}</p>`}
${notice.err && html`<p class="upload-notice upload-notice-err" role="alert">${notice.err}</p>`}
${card(
  "Your account",
  html`<p>Signed in as <a href="/u/${u.id}"><strong>${u.displayName}</strong></a> ${roleBadge(u)}
<span class="text-muted">(your public profile)</span></p>
${u.banned && html`<p class="alert alert-warning">This account is suspended: it can’t post or change its profile.</p>`}
<form method="post" action="/account" class="acct-form">
  <input type="hidden" name="action" value="name">
  <label class="form-label mb-1" for="name">Display name</label>
  <div class="input-group">
    <input class="form-control form-control-sm" id="name" name="name" value="${u.displayName}" maxlength="${NAME_MAX * 2}" required autocomplete="nickname">
    <button class="btn btn-sm btn-outline-dark" type="submit">Save</button>
  </div>
  <p class="form-hint text-muted">Shown next to everything you post, always with your verified GitHub link, so nobody can pass as someone else.</p>
</form>`,
  "account",
)}
${card(
  "Verified sign-ins",
  html`<ul class="acct-list">${u.identities.map((i) => html`<li>${identityLink(i)}</li>`)}</ul>`,
  "account",
)}
${card(
  "Links",
  html`<p class="text-muted">Your homepage, DBLP or Google Scholar. Shown on your profile marked “unverified”.</p>
<form method="post" action="/account" class="acct-form">
  <input type="hidden" name="action" value="links">
  ${rows.map(
    (l, i) => html`<div class="acct-link-row">
    <input class="form-control form-control-sm acct-link-label" name="label${i}" value="${l.label}" placeholder="Label" maxlength="40" aria-label="Link ${i + 1} label">
    <input class="form-control form-control-sm" name="url${i}" value="${l.url}" placeholder="https://" maxlength="300" aria-label="Link ${i + 1} address">
  </div>`,
  )}
  <button class="btn btn-sm btn-outline-dark" type="submit">Save links</button>
</form>`,
  "account",
)}
<form method="post" action="/auth/logout" class="acct-signout">
  <input type="hidden" name="next" value="/">
  <button class="btn btn-sm btn-outline-dark" type="submit">Sign out</button>
</form>`;
  return page(env, { title: "Your account", status, ...NO_STORE, body });
}

async function accountPost(env: Env, req: Request): Promise<Response> {
  const a = await requireUser(env, req);
  if (isAuthFailure(a)) {
    if (a.code === "signin") return redirect303("/account");
    if (a.code === "origin") return messagePage(env, 403, "Rejected", html`<p>Cross-site requests aren’t accepted.</p>`, NO_STORE);
    const me = await currentUser(env, req);
    return me ? accountPage(env, me, { err: "This account is suspended." }, 403) : redirect303("/account");
  }
  const form = await req.formData();
  const action = form.get("action")?.toString();
  if (action === "name") {
    const name = form.get("name")?.toString() ?? "";
    const problem = await nameProblem(env, a.user.id, name);
    if (problem) return accountPage(env, a, { err: problem }, 400);
    const stored = await setDisplayName(env, a.user.id, name);
    return redirect303("/account?saved=name", [loginCookie(stored)]);
  }
  if (action === "links") {
    const links: UserLink[] = [];
    for (let i = 0; i < MAX_LINKS; i++) links.push({ label: form.get(`label${i}`)?.toString() ?? "", url: form.get(`url${i}`)?.toString() ?? "" });
    const problem = await setUserLinks(env, a.user.id, links);
    if (problem) return accountPage(env, a, { err: problem }, 400);
    return redirect303("/account?saved=links");
  }
  return accountPage(env, a, { err: "Unknown action." }, 400);
}

export async function handleAccount(req: Request, env: Env, url: URL): Promise<Response> {
  const pm = PROFILE_RE.exec(url.pathname);
  const isGet = req.method === "GET" || req.method === "HEAD";
  if (pm) {
    if (!isGet) return messagePage(env, 405, "Method not allowed", html`<p>Profiles are read-only.</p>`);
    return profilePage(env, pm[1]);
  }
  if (req.method === "POST") return accountPost(env, req);
  if (!isGet) return messagePage(env, 405, "Method not allowed", html`<p>Use the forms on this page.</p>`, NO_STORE);
  const a = await currentUser(env, req);
  if (!a) return signInPage(env, url);
  return accountPage(env, a, { ok: SAVED[url.searchParams.get("saved") ?? ""] });
}
