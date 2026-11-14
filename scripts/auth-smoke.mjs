#!/usr/bin/env node
// End-to-end checks for accounts (worker/src/auth.ts) against a local `wrangler dev` with
// AUTH_DEV_LOGIN=1 in worker/.dev.vars. It writes users to the local D1, so run the server on a
// private copy of the local state:
//   DEV_STATE=copy npm --prefix worker run dev -- --port 8788
//   node scripts/auth-smoke.mjs http://localhost:8788
// Each run uses fresh made-up GitHub ids, so it can be repeated.
const BASE = (process.argv[2] ?? "http://localhost:8788").replace(/\/$/, "");
const RUN = Date.now() % 1e9;
let failed = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failed++;
}

/** A tiny browser: keeps cookies, sends Origin on POSTs like a real one. */
class Client {
  jar = new Map();
  async req(path, { method = "GET", form, headers = {}, origin = BASE, raw } = {}) {
    const h = new Headers(headers);
    if (this.jar.size) h.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    let body;
    if (form) {
      body = new URLSearchParams(form);
      h.set("content-type", "application/x-www-form-urlencoded");
    }
    if (raw !== undefined) body = raw;
    if (method !== "GET" && origin) h.set("origin", origin);
    const res = await fetch(BASE + path, { method, headers: h, body, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i).trim();
      const v = kv.slice(i + 1).trim();
      if (attrs.some((a) => /max-age=0\b/i.test(a.trim())) || v === "") this.jar.delete(k);
      else this.jar.set(k, v);
    }
    return res;
  }
  async json(path, opts) {
    const r = await this.req(path, opts);
    return { status: r.status, body: await r.json().catch(() => null), res: r };
  }
  login(login, ghid, next = "/") {
    return this.req(`/auth/dev-login?login=${login}&ghid=${ghid}&next=${encodeURIComponent(next)}`);
  }
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ------------------------------------------------------------------------------------------- step 1
test("signed out: /api/me is 401", async () => {
  const c = new Client();
  const r = await c.json("/api/me");
  check("401", r.status === 401, r.status);
  check("error code signin", r.body?.error === "signin");
  check("no-store", r.res.headers.get("cache-control") === "no-store");
});

test("dev login creates a user and a session", async () => {
  const c = new Client();
  const login = `alice${RUN}`;
  const r = await c.login(login, 900000 + (RUN % 1e5), "/2024/1");
  check("303 to next", r.status === 303 && r.headers.get("location") === "/2024/1", `${r.status} ${r.headers.get("location")}`);
  const sc = r.headers.getSetCookie().join("\n");
  check("session cookie is HttpOnly, Secure, SameSite=Lax", /__Host-oc_session=[^;]+;[^\n]*HttpOnly[^\n]*Secure[^\n]*SameSite=Lax/.test(sc), sc);
  check("oc_login cookie carries the display name", c.jar.get("oc_login") === encodeURIComponent(login));
  const me = await c.json("/api/me");
  check("/api/me 200", me.status === 200, me.status);
  check("display name = login", me.body?.user?.displayName === login);
  check("via session", me.body?.via === "session");
  const gh = me.body?.user?.identities?.[0];
  check("github identity with url and created_at", gh?.provider === "github" && gh.url === `https://github.com/${login}` && !!gh.providerCreatedAt, JSON.stringify(gh));
  check("role member", me.body?.user?.role === "member");
});

test("signing in again finds the same user (by numeric id, not login)", async () => {
  const ghid = 910000 + (RUN % 1e5);
  const a = new Client();
  await a.login(`bob${RUN}`, ghid);
  const id1 = (await a.json("/api/me")).body?.user?.id;
  const b = new Client();
  await b.login(`bobrenamed${RUN}`, ghid);
  const me = (await b.json("/api/me")).body?.user;
  check("same user id", me?.id === id1, `${me?.id} vs ${id1}`);
  check("handle refreshed", me?.identities?.[0]?.handle === `bobrenamed${RUN}`);
});

test("next= only accepts same-origin paths", async () => {
  const c = new Client();
  for (const bad of ["https://evil.example/", "//evil.example/", "/\\evil.example", "javascript:alert(1)"]) {
    const r = await c.login(`n${RUN}`, 920000 + (RUN % 1e5), bad);
    check(`next=${bad} -> /`, r.headers.get("location") === "/", r.headers.get("location"));
  }
});

test("logout: needs POST from our origin, then the session is gone", async () => {
  const c = new Client();
  await c.login(`carol${RUN}`, 930000 + (RUN % 1e5));
  const session = c.jar.get("__Host-oc_session");
  const cross = await c.req("/auth/logout", { method: "POST", form: { next: "/" }, origin: "https://evil.example" });
  check("cross-site logout refused", cross.status === 403, cross.status);
  check("still signed in", (await c.json("/api/me")).status === 200);
  const r = await c.req("/auth/logout", { method: "POST", form: { next: "/2024/1" } });
  check("303 to next", r.status === 303 && r.headers.get("location") === "/2024/1");
  check("cookies cleared", !c.jar.has("__Host-oc_session") && !c.jar.has("oc_login"));
  const replay = new Client();
  replay.jar.set("__Host-oc_session", session);
  check("old session token no longer works", (await replay.json("/api/me")).status === 401);
});

test("a forged session cookie is rejected", async () => {
  const c = new Client();
  c.jar.set("__Host-oc_session", "not-a-real-token");
  check("401", (await c.json("/api/me")).status === 401);
});

test("GitHub sign-in without a configured app explains itself", async () => {
  const r = await new Client().req("/auth/github?next=/");
  // 303 to github.com when GITHUB_CLIENT_ID is set locally, else a 503 page.
  const loc = r.headers.get("location") ?? "";
  const ok = r.status === 503 || (r.status === 303 && loc.startsWith("https://github.com/login/oauth/authorize?") && /code_challenge_method=S256/.test(loc));
  check("503 page or PKCE redirect to GitHub", ok, `${r.status} ${loc}`);
});

test("callback without our state cookie is refused", async () => {
  const r = await new Client().req("/auth/github/callback?code=x&state=y");
  check("400", r.status === 400, r.status);
});

// ------------------------------------------------------------------------------------------- step 2
const form = (c, fields) => c.req("/account", { method: "POST", form: fields });

test("/account: sign-in page when signed out, settings when signed in", async () => {
  const out = await new Client().req("/account?next=/2024/1");
  const t = await out.text();
  check("signed-out page says Sign in", out.status === 200 && /Sign in/.test(t));
  check("no-store", out.headers.get("cache-control") === "no-store");
  const c = new Client();
  await c.login(`dora${RUN}`, 940000 + (RUN % 1e5));
  const r = await c.req("/account");
  const body = await r.text();
  check("settings page shows the name", r.status === 200 && body.includes(`dora${RUN}`));
  check("settings page no-store", r.headers.get("cache-control") === "no-store");
});

test("display name rules", async () => {
  const a = new Client();
  await a.login(`erin${RUN}`, 950000 + (RUN % 1e5));
  const b = new Client();
  await b.login(`frank${RUN}`, 960000 + (RUN % 1e5));
  let r = await form(a, { action: "name", name: `  Erin   Example ${RUN} ` });
  check("valid name saved (303)", r.status === 303, r.status);
  check("oc_login updated", decodeURIComponent(a.jar.get("oc_login") ?? "") === `Erin Example ${RUN}`);
  const me = (await a.json("/api/me")).body?.user;
  check("whitespace normalized", me?.displayName === `Erin Example ${RUN}`, me?.displayName);
  r = await form(b, { action: "name", name: `ERIN EXAMPLE ${RUN}` });
  check("name taken (case-insensitive) -> 400", r.status === 400 && /already uses/.test(await r.text()), r.status);
  r = await form(b, { action: "name", name: `erin${RUN}` });
  check("someone else's GitHub login -> 400", r.status === 400 && /GitHub username/.test(await r.text()), r.status);
  for (const bad of ["deleted user", "user-abcdefghijkl", "<script>", "x".repeat(41), ""]) {
    r = await form(b, { action: "name", name: bad });
    check(`rejected: ${JSON.stringify(bad.slice(0, 20))}`, r.status === 400, r.status);
  }
  r = await form(b, { action: "name", name: `Frank Ünïcødé ${RUN}` });
  check("unicode letters ok", r.status === 303, r.status);
  r = await c_cross(b);
  check("cross-site name change refused", r.status === 403, r.status);
});
const c_cross = (c) => c.req("/account", { method: "POST", form: { action: "name", name: "Mallory" }, origin: "https://evil.example" });

test("a GitHub login's owner gets their name back from a squatter", async () => {
  const squatter = new Client();
  await squatter.login(`sq${RUN}`, 970000 + (RUN % 1e5));
  const victim = `victim${RUN}`;
  await form(squatter, { action: "name", name: victim });
  check("squatter took the name", (await squatter.json("/api/me")).body?.user?.displayName === victim);
  const v = new Client();
  await v.login(victim, 980000 + (RUN % 1e5));
  check("owner gets their login as name", (await v.json("/api/me")).body?.user?.displayName === victim);
  const sname = (await squatter.json("/api/me")).body?.user?.displayName;
  check("squatter renamed to user-<id>", /^user-[a-z2-7]{12}$/.test(sname), sname);
});

test("links: saved, validated, shown as unverified on the cached profile", async () => {
  const c = new Client();
  await c.login(`gail${RUN}`, 990000 + (RUN % 1e5));
  let r = await form(c, { action: "links", label0: "Homepage", url0: "example.org/~gail", label1: "", url1: "https://dblp.org/pid/1" });
  check("saved", r.status === 303, r.status);
  r = await form(c, { action: "links", label0: "x", url0: "javascript:alert(1)" });
  check("javascript: refused", r.status === 400, r.status);
  const id = (await c.json("/api/me")).body?.user?.id;
  const p = await new Client().req(`/u/${id}`);
  const t = await p.text();
  check("profile 200, publicly cached", p.status === 200 && p.headers.get("cache-control") === "public, max-age=600", `${p.status} ${p.headers.get("cache-control")}`);
  check("profile is noindex", /<meta name="robots" content="noindex">/.test(t));
  check("https added, label kept", t.includes('href="https://example.org/~gail"') && t.includes(">Homepage<"));
  check("blank label -> host", t.includes(">dblp.org<"));
  check("links are nofollow ugc", /rel="nofollow ugc noopener"/.test(t));
  check("marked unverified", /unverified/.test(t));
  check("verified GitHub link shown", t.includes(`https://github.com/gail${RUN}`) && /on GitHub since 2015/.test(t));
  check("unknown profile 404", (await new Client().req("/u/aaaaaaaaaaaa")).status === 404);
});

test("navbar renders the static Sign in link (app.js swaps in the name)", async () => {
  const t = await (await new Client().req("/")).text();
  check("nav-account link", /class="nav-account">Sign in</.test(t));
});

// ------------------------------------------------------------------------------------------------
for (const [name, fn] of tests) {
  console.log(`\n# ${name}`);
  try {
    await fn();
  } catch (e) {
    check("threw", false, e?.stack ?? String(e));
  }
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
