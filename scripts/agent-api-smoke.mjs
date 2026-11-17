#!/usr/bin/env node
// End-to-end checks for the agent API (worker/src/agentapi.ts) against a local `wrangler dev`
// with AUTH_DEV_LOGIN=1 and MAINTAINER_GITHUB_IDS=4242 in worker/.dev.vars, on a private copy of
// the local state (the agent API section of db/schema.sql applied to it):
//   DEV_STATE=copy npm --prefix worker run dev -- --port 8788
//   node scripts/agent-api-smoke.mjs http://localhost:8788
const BASE = (process.argv[2] ?? "http://localhost:8791").replace(/\/$/, "");
const RUN = Date.now() % 1e9;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failed++;
};

class Client {
  jar = new Map();
  async req(path, { method = "GET", body, headers = {}, origin = BASE } = {}) {
    const h = new Headers(headers);
    if (!h.has("sec-fetch-site")) h.set("sec-fetch-site", "same-origin");
    if (this.jar.size) h.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
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
  login(login, ghid) {
    return this.req(`/auth/dev-login?login=${login}&ghid=${ghid}&name=${encodeURIComponent(login)}`);
  }
  /** The whole connect flow: the agent asks, this person approves, the agent collects. */
  async newToken() {
    const d = await startConnect();
    await this.approve(d.user_code, "approve");
    return (await collect(d.device_code)).j.access_token;
  }
  approve(code, decision) {
    return this.req("/connect", { method: "POST", body: new URLSearchParams({ code, decision }) });
  }
}

const startConnect = async () => (await fetch(`${BASE}/api/oauth/device`, { method: "POST" })).json();
const collect = async (device_code) => {
  const r = await fetch(`${BASE}/api/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code }),
  });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};

/** A small valid one-page PDF. */
function makePdf(text, catalog = "") {
  const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    `<< /Type /Catalog /Pages 2 0 R ${catalog} >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.7\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const META = { title: `A $2^{61}$ attack, posted by an agent ${RUN}`, authors: ["Claude Fable 5.2", "Ada Lovelace"], abstract: "We attack $a_1 * b_2$.", license: "CC-BY-4.0" };
/** multipart with the PDF and the metadata (as a text field by default, as curl -F "metadata=<f"). */
function post(token, pdf, meta = META, { asFile = false, fields = null } = {}) {
  const fd = new FormData();
  if (pdf) fd.append("file", new Blob([pdf], { type: "application/pdf" }), "paper.pdf");
  if (fields) for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) fd.append(k, x);
  else if (asFile) fd.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }), "meta.json");
  else fd.append("metadata", JSON.stringify(meta));
  return fetch(`${BASE}/api/manuscripts`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: fd });
}
const body = async (r) => r.json().catch(() => ({}));

const me = new Client();
await me.login(`agent${RUN}`, 1400000 + (RUN % 1e5));

console.log("\n# connecting: the agent asks, the person approves with one click");
let d = await startConnect();
check("device authorization response (RFC 8628 fields)", d.device_code && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(d.user_code) && d.verification_uri_complete?.endsWith(`/connect?code=${d.user_code}`) && d.interval === 5 && d.expires_in === 900, JSON.stringify(d));
let c = await collect(d.device_code);
check("before approval: authorization_pending", c.s === 400 && c.j.error === "authorization_pending", JSON.stringify(c));
const linkPath = new URL(d.verification_uri_complete).pathname + new URL(d.verification_uri_complete).search;
let r = await new Client().req(linkPath);
check("approve link, logged out: sent to log in and back", r.status === 303 && r.headers.get("location") === `/account?next=${encodeURIComponent(`/connect?code=${d.user_code}`)}`, r.headers.get("location"));
let t = await (await me.req(linkPath)).text();
check("approve page: as whom, what it can do, for how long", t.includes("Connect an agent?") && t.includes(`agent${RUN}`) && /can’t change your account/.test(t) && /ends after 24 hours/.test(t));
check("approve page has no key to copy", !/oct_/.test(t));
r = await me.req("/connect", { method: "POST", body: new URLSearchParams({ code: d.user_code, decision: "approve" }), origin: "https://evil.example" });
check("cross-site approve refused", r.status === 403);
r = await me.approve(d.user_code, "approve");
check("approve: connected", r.status === 200 && /Connected/.test(await r.text()));
c = await collect(d.device_code);
const lost = c.j.access_token;
check("agent collects its token, valid 24 hours", c.s === 200 && /^oct_/.test(lost ?? "") && c.j.token_type === "Bearer" && c.j.expires_in === 86400 && Math.abs(Date.parse(c.j.expires_at) - Date.now() - 86400e3) < 60e3 && c.j.user?.displayName === `agent${RUN}`, JSON.stringify(c.j).slice(0, 160));
c = await collect(d.device_code);
const tok = c.j.access_token;
check("lost it? the same device_code gives a new token", c.s === 200 && /^oct_/.test(tok ?? "") && tok !== lost);
check("and the lost one stops working", (await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${lost}` } })).status === 401);
check("the link is used up", (await me.req(linkPath)).status === 410);
d = await startConnect();
await me.approve(d.user_code, "deny");
check("declined: access_denied", (await collect(d.device_code)).j.error === "access_denied");
check("unknown code: 410", (await me.req("/connect?code=BBBB-CCCC")).status === 410);
check("unknown device_code: expired_token", (await collect("nope")).j.error === "expired_token");
const acct = await (await me.req("/account")).text();
check("nothing to manage on the account page", !/id="agents"|Disconnect|Create token|oct_/.test(acct));

console.log("\n# /api/me");
r = await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${tok}` } });
let j = await body(r);
check("token: who you post as", r.status === 200 && j.user?.displayName === `agent${RUN}` && /\/u\/[a-z2-7]{12}$/.test(j.user?.profile_url ?? "") && Date.parse(j.expires_at) > Date.now(), JSON.stringify(j));
r = await fetch(`${BASE}/api/me`, { headers: { authorization: "Bearer oct_nope" } });
check("unknown token: 401 token_revoked + WWW-Authenticate", r.status === 401 && (await body(r)).error === "token_revoked" && /Bearer/.test(r.headers.get("www-authenticate") ?? ""));
check("cookie /api/me unchanged", (await me.req("/api/me")).status === 200);

console.log("\n# posting");
const pdf1 = makePdf(`agent paper ${RUN}`);
r = await post(null, pdf1);
check("no token: 401 no_token", r.status === 401 && (await body(r)).error === "no_token");
r = await post(tok, pdf1, { ...META, license: "" });
j = await body(r);
check("license required", r.status === 400 && j.error === "license_not_accepted", JSON.stringify(j));
r = await fetch(`${BASE}/api/manuscripts`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(META) });
check("JSON body: 415 multipart_required", r.status === 415 && (await body(r)).error === "multipart_required");
r = await post(tok, pdf1, { ...META, authors: "Ada" });
check("bad authors: 400", r.status === 400 && (await body(r)).error === "bad_metadata");
r = await post(tok, makePdf("script", "/OpenAction << /S /JavaScript /JS (app.alert(1)) >>"));
check("JavaScript PDF: 422 active_content", r.status === 422 && (await body(r)).error === "active_content");
r = await post(tok, new TextEncoder().encode("not a pdf"));
check("not a PDF: 415 not_pdf", r.status === 415 && (await body(r)).error === "not_pdf");

r = await post(tok, pdf1);
j = await body(r);
const id = j.id;
check("201 with the manuscript", r.status === 201 && /^\d{4}-\d{2}-\d{2}\/\d+$/.test(id ?? "") && j.duplicate === false, `${r.status} ${JSON.stringify(j).slice(0, 200)}`);
// (wrangler dev rewrites the Location host to localhost; compare the path)
check("Location header", new URL(r.headers.get("location") ?? "x:").pathname === new URL(j.url ?? "x:").pathname, r.headers.get("location"));
check("math survives", j.title === META.title && j.abstract === META.abstract);
check("authors in order, bibtex, pdf_url", JSON.stringify(j.authors) === JSON.stringify(META.authors) && /author\s+= \{\{Claude Fable 5\.2\} and \{Ada Lovelace\}\}/.test(j.bibtex ?? "") && j.pdf_url?.endsWith(`/${id}.pdf`));
const pg = await (await me.req(`/${id}`)).text();
check("page shows the person as uploader, nothing about the agent", pg.includes(`agent${RUN}`) && !/Claude Code test|via (an )?agent|API/i.test(pg.slice(pg.indexOf("<main"), pg.indexOf("</main>"))));
const pdfBack = new Uint8Array(await (await fetch(`${BASE}/${id}.pdf`)).arrayBuffer());
check("same PDF bytes", pdfBack.length === pdf1.length);

console.log("\n# retries and duplicates");
r = await post(tok, pdf1);
j = await body(r);
check("same PDF + metadata: 200 duplicate", r.status === 200 && j.duplicate === true && j.id === id, `${r.status} ${JSON.stringify(j).slice(0, 120)}`);
r = await post(tok, pdf1, { ...META, title: "Corrected title" });
j = await body(r);
check("same PDF, other metadata: 409 duplicate_pdf with the id", r.status === 409 && j.error === "duplicate_pdf" && j.id === id, JSON.stringify(j));
const pdf2 = makePdf(`parallel ${RUN}`);
const par = await Promise.all([1, 2, 3, 4].map(() => post(tok, pdf2).then(async (x) => ({ s: x.status, j: await body(x) }))));
const created = par.filter((x) => x.s === 201);
check("4 parallel identical posts: exactly one created", created.length === 1 && par.every((x) => x.j.id === created[0]?.j.id), par.map((x) => x.s).join(","));

console.log("\n# other ways to send the metadata");
r = await post(tok, makePdf(`file meta ${RUN}`), { ...META, title: `As a file ${RUN}` }, { asFile: true });
check("metadata as a file part (curl -F metadata=@meta.json)", r.status === 201, `${r.status} ${JSON.stringify(await body(r)).slice(0, 150)}`);
r = await post(tok, makePdf(`fields ${RUN}`), null, { fields: { title: `Separate fields ${RUN}`, author: ["A. One", "B. Two"], abstract: "Fields.", license: "cc-by-4.0" } });
j = await body(r);
check("separate fields, license case-insensitive", r.status === 201 && JSON.stringify(j.authors) === '["A. One","B. Two"]', `${r.status} ${JSON.stringify(j).slice(0, 150)}`);

console.log("\n# daily limit under parallel posts");
const many = await Promise.all(Array.from({ length: 20 }, (_, i) => post(tok, makePdf(`many ${RUN} ${i}`), { ...META, title: `Many ${i}` }).then((x) => x.status)));
const mine = (await (await fetch(`${BASE}/api/manuscripts?limit=100`)).json()).manuscripts.filter((m) => m.uploaded_by?.name === `agent${RUN}`);
check("never more than 20 a day, the rest 429", mine.length === 20 && many.filter((s) => s === 429).length === 20 - (20 - 4), `created ${mine.length}; statuses ${many.join(",")}`);

console.log("\n# reading");
r = await fetch(`${BASE}/api/manuscripts/${id}`);
j = await body(r);
check("GET one: public JSON", r.status === 200 && j.id === id && r.headers.get("access-control-allow-origin") === "*");
check("GET unknown: 404", (await fetch(`${BASE}/api/manuscripts/2001-01-01/9`)).status === 404);

console.log("\n# several agents, cut off by a maintainer");
const tok2 = await me.newToken();
check("a second connect gives a second working token", tok2 && tok2 !== tok && (await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${tok2}` } })).status === 200);
const live = tok;
const m = new Client();
await m.login(`maint${RUN}`, 4242);
// The live token posts one more (another account, under its limit) to test removal + disconnect.
const other = new Client();
await other.login(`agentb${RUN}`, 1500000 + (RUN % 1e5));
const tokB = await other.newToken();
j = await body(await post(tokB, makePdf(`spam ${RUN}`), { ...META, title: `Spam ${RUN}` }));
r = await m.req("/manuscripts/remove", { method: "POST", body: new URLSearchParams({ id: j.id, revoke: "yes" }), headers: { "content-type": "application/x-www-form-urlencoded" } });
check("maintainer removes and disconnects its agent", r.status === 200 && /disconnected/.test(await r.text()));
check("that agent's token stops working", (await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${tokB}` } })).status === 401);
check("removed: API 410", (await fetch(`${BASE}/api/manuscripts/${j.id}`)).status === 410);
check("the other account's token still works", (await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${live}` } })).status === 200);

console.log("\n# deleting the account revokes its tokens");
const del = new Client();
await del.login(`agentc${RUN}`, 1600000 + (RUN % 1e5));
const tokC = await del.newToken();
await del.req("/account", { method: "POST", body: new URLSearchParams({ action: "delete", confirm: "yes" }) });
check("token of a deleted account: 401", (await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${tokC}` } })).status === 401);

console.log("\n# llms.txt");
const llms = await (await fetch(`${BASE}/llms.txt`)).text();
check("documents the agent API", llms.includes("Posting original manuscripts (for agents)") && llms.includes("/api/manuscripts") && !llms.includes("is coming"));

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
