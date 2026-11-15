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
    // Like a click on one of our own pages (tests of cross-site requests override it).
    if (!h.has("sec-fetch-site")) h.set("sec-fetch-site", "same-origin");
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

const loginInfo = (c) => {
  try { return JSON.parse(decodeURIComponent(c.jar.get("oc_login") ?? "")); } catch { return null; }
};

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
  check("oc_login cookie carries the name (JSON)", loginInfo(c)?.n === login, c.jar.get("oc_login"));
  const me = await c.json("/api/me");
  check("/api/me 200", me.status === 200, me.status);
  check("display name = login", me.body?.user?.displayName === login);
  const gh = me.body?.user?.identities?.[0];
  check("github identity with url", gh?.provider === "github" && gh.url === `https://github.com/${login}`, JSON.stringify(gh));
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
  for (const bad of ["https://evil.example/", "//evil.example/", "/\\evil.example", "javascript:alert(1)"]) {
    const r = await new Client().login(`n${RUN}`, 920000 + (RUN % 1e5), bad);
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

test("/account: log-in page when logged out, settings when logged in", async () => {
  const out = await new Client().req("/account?next=/2024/1");
  const t = await out.text();
  check("logged-out page says Log in", out.status === 200 && /Log in to/.test(t));
  check("no-store", out.headers.get("cache-control") === "no-store");
  const c = new Client();
  await c.login(`dora${RUN}`, 940000 + (RUN % 1e5));
  const r = await c.req("/account");
  const body = await r.text();
  check("settings page shows the name", r.status === 200 && body.includes(`dora${RUN}`));
  check("settings page no-store", r.headers.get("cache-control") === "no-store");
  check("no internal id on the page", !body.includes((await c.json("/api/me")).body?.user?.id));
});

test("names: from the log-in methods, editable, not unique", async () => {
  const a = new Client();
  await a.login(`erin${RUN}`, 950000 + (RUN % 1e5));
  const b = new Client();
  await b.login(`frank${RUN}`, 960000 + (RUN % 1e5));
  let r = await form(a, { action: "name", name: `  Wei   Zhang ` });
  check("custom name saved (303)", r.status === 303, r.status);
  check("oc_login updated", loginInfo(a)?.n === "Wei Zhang", a.jar.get("oc_login"));
  const me = (await a.json("/api/me")).body?.user;
  check("whitespace normalized", me?.displayName === "Wei Zhang" && me?.customName === "Wei Zhang", me?.displayName);
  r = await form(b, { action: "name", name: "wei zhang" });
  check("two people can share a name", r.status === 303, r.status);
  for (const bad of ["", "   ", "x".repeat(61)]) {
    r = await form(b, { action: "name", name: bad });
    check(`rejected: ${JSON.stringify(bad.slice(0, 20))}`, r.status === 400, r.status);
  }
  r = await form(b, { action: "name", name: "张伟 (Zhang Wei)" });
  check("any script ok", r.status === 303, r.status);
  r = await form(a, { action: "name-reset" });
  check("reset to the log-in name", r.status === 303 && (await a.json("/api/me")).body?.user?.displayName === `erin${RUN}`, r.status);
  r = await c_cross(b);
  check("cross-site name change refused", r.status === 403, r.status);
});
const c_cross = (c) => c.req("/account", { method: "POST", form: { action: "name", name: "Mallory" }, origin: "https://evil.example" });

test("a stale oc_login cookie is cleared by /account", async () => {
  const c = new Client();
  c.jar.set("oc_login", "Ghost");
  await c.req("/account");
  check("cleared", !c.jar.has("oc_login"));
});

test("navbar renders the static Log in link (app.js swaps in the photo)", async () => {
  const t = await (await new Client().req("/")).text();
  check("nav-account link", /class="nav-account">Log in</.test(t));
});

test("deleting an account; the same GitHub signs up fresh", async () => {
  const c = new Client();
  const login = `mo${RUN}`;
  const ghid = 1050000 + (RUN % 1e5);
  await c.login(login, ghid);
  const id = (await c.json("/api/me")).body?.user?.id;
  let r = await form(c, { action: "delete" });
  check("needs the confirmation box", r.status === 422, r.status);
  r = await form(c, { action: "delete", confirm: "yes" });
  check("deleted, signed out", r.status === 303 && !c.jar.has("__Host-oc_session"), r.status);
  const again = new Client();
  await again.login(login, ghid);
  const me2 = (await again.json("/api/me")).body?.user;
  check("a fresh account", me2?.id !== id && me2?.displayName === login, `${me2?.id} ${me2?.displayName}`);
});

// Needs MAINTAINER_GITHUB_IDS=4242 in worker/.dev.vars.
const MAINT_GHID = 4242;
test("maintainer role from MAINTAINER_GITHUB_IDS", async () => {
  const m = new Client();
  await m.login(`maint${RUN}`, MAINT_GHID);
  const me = (await m.json("/api/me")).body?.user;
  check("maintainer", me?.role === "maintainer", me?.role);
  check("badge on /account", /settings-badge">maintainer/.test(await (await m.req("/account")).text()));
});

// ------------------------------------------------------------------------------------------- step 5
const orcidOf = (n) => {
  // A made-up but well-formed iD (ISO 7064 check digit), unique per run.
  const base = String(RUN * 10 + n).padStart(15, "0").slice(-15);
  let t = 0;
  for (const d of base) t = (t + Number(d)) * 2;
  const r = (12 - (t % 11)) % 11;
  const s = base + (r === 10 ? "X" : String(r));
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12)}`;
};
const devOrcid = (c, orcid, name = "", next = "/account") =>
  c.req(`/auth/dev-orcid?link=1&orcid=${orcid}&name=${encodeURIComponent(name)}&next=${encodeURIComponent(next)}`);

test("ORCID: link to a GitHub account, then sign in with either", async () => {
  const c = new Client();
  const ghid = 1060000 + (RUN % 1e5);
  await c.login(`nia${RUN}`, ghid);
  const orcid = orcidOf(1);
  const r = await devOrcid(c, orcid);
  check("linked (303 /account?saved=linked)", r.status === 303 && r.headers.get("location") === "/account?saved=linked", `${r.status} ${r.headers.get("location")}`);
  const me = (await c.json("/api/me")).body?.user;
  const oi = me?.identities?.find((i) => i.provider === "orcid");
  check("orcid identity: handle = iD, url", oi?.handle === orcid && oi?.url === `https://orcid.org/${orcid}`, JSON.stringify(oi));
  const viaOrcid = new Client();
  await devOrcid(viaOrcid, orcid, "Someone Else");
  check("signing in with the ORCID iD reaches the same account", (await viaOrcid.json("/api/me")).body?.user?.id === me?.id);
  const other = new Client();
  await other.login(`otto${RUN}`, 1070000 + (RUN % 1e5));
  const steal = await devOrcid(other, orcid);
  check("an iD linked elsewhere: offers a merge, nothing moved yet", steal.status === 303 && steal.headers.get("location") === "/account/merge" && (await other.json("/api/me")).body?.user?.identities?.length === 1, `${steal.status} ${steal.headers.get("location")}`);
  check("cancelling the merge leaves both accounts as they were", (await form(other, { action: "merge-cancel" })).headers.get("location") === "/account?saved=merge-cancelled");
  check("the iD still reaches its own account", (await viaOrcid.json("/api/me")).body?.user?.id === me?.id);
});

test("ORCID-only accounts", async () => {
  const c = new Client();
  const orcid = orcidOf(2);
  await devOrcid(c, orcid, `Wang Fang ${RUN}`, "/2024/1");
  const me = (await c.json("/api/me")).body?.user;
  check("account created, named from ORCID", me?.displayName === `Wang Fang ${RUN}`, me?.displayName);
  check("only identity is ORCID", me?.identities?.length === 1 && me.identities[0].provider === "orcid");
  const d = new Client();
  await devOrcid(d, orcidOf(3), `Wang Fang ${RUN}`);
  check("a second person with the same ORCID name keeps it", (await d.json("/api/me")).body?.user?.displayName === `Wang Fang ${RUN}`);
});

// ------------------------------------------------------------------------------------------- step 6
const devGoogle = (c, sub, email, name = "", next = "/account") =>
  c.req(`/auth/dev-google?link=1&sub=${sub}&email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}&next=${encodeURIComponent(next)}`);

test("Google: sign in first, keeps only the email domain", async () => {
  const c = new Client();
  const sub = String(2000000000 + RUN);
  const r = await devGoogle(c, sub, `qi${RUN}@Example.EDU`, `Qi ${RUN}`, "/2024/1");
  check("303 to next", r.status === 303 && r.headers.get("location") === "/2024/1", `${r.status} ${r.headers.get("location")}`);
  const me = await c.json("/api/me");
  const gi = me.body?.user?.identities?.[0];
  check("named from Google", me.body?.user?.displayName === `Qi ${RUN}`, me.body?.user?.displayName);
  check("google identity: domain only, no link", gi?.provider === "google" && gi.handle === "example.edu" && gi.url === "", JSON.stringify(gi));
  check("no email address anywhere in /api/me", !JSON.stringify(me.body).includes("@"));
  const page = await (await c.req("/account")).text();
  check("shown as verified @example.edu", page.includes("verified @example.edu"));
  const g = new Client();
  await devGoogle(g, String(2100000000 + RUN), `someone${RUN}@gmail.com`);
  const gp = await (await g.req("/account")).text();
  check("gmail: shown as just a Google account", gp.includes(">Google account<") && !gp.includes("@gmail.com"));
});

test("any first sign-in, then add the others; each one signs in to the same account", async () => {
  const c = new Client();
  const sub = String(2200000000 + RUN);
  await devGoogle(c, sub, `ray${RUN}@uni.example`);
  const id = (await c.json("/api/me")).body?.user?.id;
  const ghid = 1100000 + (RUN % 1e5);
  let r = await c.req(`/auth/dev-login?login=ray${RUN}&ghid=${ghid}&link=1&next=/account`);
  check("GitHub added (303 saved=linked)", r.status === 303 && r.headers.get("location") === "/account?saved=linked", `${r.status} ${r.headers.get("location")}`);
  const orcid = orcidOf(5);
  r = await devOrcid(c, orcid);
  check("ORCID added", r.headers.get("location") === "/account?saved=linked", r.headers.get("location"));
  const ids = (await c.json("/api/me")).body?.user?.identities?.map((i) => i.provider).sort().join(",");
  check("three identities", ids === "github,google,orcid", ids);
  for (const [label, signIn] of [
    ["GitHub", (x) => x.login(`ray${RUN}`, ghid)],
    ["Google", (x) => devGoogle(x, sub, `ray${RUN}@uni.example`)],
    ["ORCID", (x) => devOrcid(x, orcid)],
  ]) {
    const x = new Client();
    await signIn(x);
    check(`${label} reaches the same account`, (await x.json("/api/me")).body?.user?.id === id);
  }
  const other = new Client();
  await other.login(`sam${RUN}`, 1110000 + (RUN % 1e5));
  r = await devGoogle(other, sub, `ray${RUN}@uni.example`);
  check("someone else's Google account: merge offered, not added", r.status === 303 && r.headers.get("location") === "/account/merge", `${r.status} ${r.headers.get("location")}`);
  await form(other, { action: "merge-cancel" });
});

test("sign-in page offers all three providers", async () => {
  const t = await (await new Client().req("/account")).text();
  check("GitHub, Google, ORCID buttons", /Continue with GitHub/.test(t) && /Continue with Google/.test(t) && /Continue with ORCID/.test(t));
  const r = await new Client().req("/auth/google?next=/");
  const loc = r.headers.get("location") ?? "";
  check("Google: 503 page or PKCE redirect", r.status === 503 || (loc.startsWith("https://accounts.google.com/") && /code_challenge_method=S256/.test(loc)), `${r.status} ${loc}`);
});

// ------------------------------------------------------------------------------------------ merging
test("merging: adding another account's sign-in merges that account in, after confirming", async () => {
  const a = new Client();
  await a.login(`xena${RUN}`, 1160000 + (RUN % 1e5));
  const aId = (await a.json("/api/me")).body?.user?.id;
  const b = new Client();
  const orcid = orcidOf(9);
  await devOrcid(b, orcid, `Yuki ${RUN}`);
  const bId = (await b.json("/api/me")).body?.user?.id;
  let r = await devOrcid(a, orcid);
  check("redirects to the merge screen", r.status === 303 && r.headers.get("location") === "/account/merge", `${r.status} ${r.headers.get("location")}`);
  const page = await (await a.req("/account/merge")).text();
  check("the screen names both accounts, no ids", page.includes(`xena${RUN}`) && page.includes(`Yuki ${RUN}`) && !page.includes(aId) && !page.includes(bId));
  r = await a.req("/account", { method: "POST", form: { action: "merge" }, origin: "https://evil.example" });
  check("cross-site confirm refused", r.status === 403, r.status);
  check("a different signed-in user can't use the offer", (await form(b, { action: "merge" })).status === 410);
  r = await form(a, { action: "merge" });
  check("merged (303 saved=merged)", r.status === 303 && r.headers.get("location") === "/account?saved=merged", `${r.status} ${r.headers.get("location")}`);
  const me = (await a.json("/api/me")).body?.user;
  check("kept account has both log-ins; its name now comes from ORCID", me?.id === aId && me?.displayName === `Yuki ${RUN}` && me?.identities?.map((i) => i.provider).sort().join(",") === "github,orcid", JSON.stringify(me));
  check("the merged account's sessions ended", (await b.json("/api/me")).status === 401);
  const viaOrcid = new Client();
  await devOrcid(viaOrcid, orcid);
  check("the ORCID iD now reaches the kept account", (await viaOrcid.json("/api/me")).body?.user?.id === aId, bId);
  check("the offer is used up", (await form(a, { action: "merge" })).status === 410);
});

// ------------------------------------------------------------------------------- security review fixes
test("adding a sign-in needs link=1 from our own page", async () => {
  const c = new Client();
  await c.login(`tess${RUN}`, 1120000 + (RUN % 1e5));
  const orcid = orcidOf(6);
  let r = await c.req(`/auth/dev-orcid?link=1&orcid=${orcid}`, { headers: { "sec-fetch-site": "cross-site" } });
  check("cross-site: not linked, sent to /account", r.status === 303 && r.headers.get("location") === "/account", `${r.status} ${r.headers.get("location")}`);
  r = await c.req(`/auth/dev-orcid?orcid=${orcid}`);
  check("no link=1: not linked", r.status === 303 && r.headers.get("location") === "/account", `${r.status} ${r.headers.get("location")}`);
  const ids = (await c.json("/api/me")).body?.user?.identities?.length;
  check("still one sign-in", ids === 1, ids);
});

test("no way to remove a single log-in method", async () => {
  const a = new Client();
  await a.login(`vera${RUN}`, 1140000 + (RUN % 1e5));
  await devOrcid(a, orcidOf(7));
  const r = await form(a, { action: "identity", provider: "orcid", pid: orcidOf(7), change: "remove" });
  check("refused (400)", r.status === 400, r.status);
  check("still two", (await a.json("/api/me")).body?.user?.identities?.length === 2);
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
