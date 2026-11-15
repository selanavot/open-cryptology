#!/usr/bin/env node
// End-to-end checks for original manuscripts (worker/src/manuscripts.ts) against a local
// `wrangler dev` with AUTH_DEV_LOGIN=1 and MAINTAINER_GITHUB_IDS=4242 in worker/.dev.vars, on a
// private copy of the local state:
//   DEV_STATE=copy npm --prefix worker run dev -- --port 8788
//   node scripts/manuscripts-smoke.mjs http://localhost:8788
const BASE = (process.argv[2] ?? "http://localhost:8788").replace(/\/$/, "");
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
}

const MD = `# A $2^{61}$ attack on 7-round SampleCipher-${RUN}

## Abstract

We attack 7 rounds in time $2^{61}$ with $a_1 * b_2$ in the abstract.

## Introduction

The best attack reaches 6 rounds[^old25], see also ePrint 2019/256 and <script>alert(1)</script>.

> **Theorem 1.** Seven rounds fall in time $2^{61}$.

## Methodology

Written by an agent.

| Rounds | Correlation |
|---|---|
| 5 | $2^{-18}$ |

[^old25]: A. Author. Cryptanalysis of reduced SampleCipher. 2025.
`;

function submitForm(fields, file = { name: "paper.md", text: MD }) {
  const fd = new FormData();
  if (file) fd.append("file", new Blob([file.text], { type: "text/markdown" }), file.name);
  for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) fd.append(k, x);
  return fd;
}

const me = new Client();
await me.login(`ms${RUN}`, 1300000 + (RUN % 1e5));

console.log("\n# submit page");
let r = await new Client().req("/submit");
check("logged out: sent to log in", r.status === 303 && r.headers.get("location") === "/account?next=/submit", `${r.status} ${r.headers.get("location")}`);
r = await me.req("/submit");
check("logged in: the form", r.status === 200 && /Submit an original manuscript/.test(await r.text()), r.status);

console.log("\n# validation");
const bad = async (name, fd, re) => {
  const x = await me.req("/submit", { method: "POST", body: fd });
  const t = await x.text();
  check(name, x.status === 400 && re.test(t), `${x.status} ${t.match(/role="alert">([^<]*)/)?.[1]}`);
};
await bad("no file", submitForm({ author: "A", agree: "yes" }, null), /Choose a Markdown/);
await bad("not Markdown", submitForm({ author: "A", agree: "yes" }, { name: "x.pdf", text: "%PDF" }), /Markdown \(\.md\) files/);
await bad("no authors", submitForm({ agree: "yes" }), /at least one author/);
await bad("no agreement", submitForm({ author: "A" }), /agree to the terms/);
r = await me.req("/submit", { method: "POST", body: submitForm({ author: "A", agree: "yes" }), origin: "https://evil.example" });
check("cross-site post refused", r.status === 403, r.status);

console.log("\n# publish");
r = await me.req("/submit", { method: "POST", body: submitForm({ author: ["Claude Fable 5.2", "  ", `Ada ${RUN}`], agree: "yes" }) });
const loc = r.headers.get("location") ?? "";
check("published, redirected to /YYYY-MM-DD/N", r.status === 303 && /^\/\d{4}-\d{2}-\d{2}\/\d+$/.test(loc), `${r.status} ${loc}`);
const id = loc.slice(1);
const today = new Date().toISOString().slice(0, 10);
check("id is today's UTC date", id.startsWith(today + "/"), id);

console.log("\n# manuscript page");
const pg = await (await new Client().req(`/${id}`)).text();
check("title from the file (# heading)", pg.includes(`SampleCipher-${RUN}`));
check("authors, blank ones dropped", pg.includes(`Claude Fable 5.2, Ada ${RUN}`));
check("uploaded by, with the profile link", /Uploaded by <a class="ms-person" href="\/u\/[a-z2-7]{12}"/.test(pg));
check("abstract from ## Abstract", pg.includes("$a_1 * b_2$"));
check("Cite as", pg.includes(`Open Cryptology ${id}`));
check("BibTeX, one braced entry per author", pg.includes(`author       = {{Claude Fable 5.2} and {Ada ${RUN}}}`));
check("links to the .md", pg.includes(`href="/${id}.md"`));
check("Scholar tags", pg.includes('name="citation_title"') && (pg.match(/name="citation_author"/g) ?? []).length === 2);
check("full text not on this page", !pg.includes("Seven rounds fall"));

console.log("\n# reading page and raw Markdown");
const rd = await (await new Client().req(`/${id}.md`, { headers: { accept: "text/html" } })).text();
check("reading page", rd.includes('class="rd"') && rd.includes("Seven rounds fall"));
check("numbered sections + contents", rd.includes('id="introduction"') && rd.includes(">1 Introduction<") && rd.includes(">2 Methodology<"));
check("title and abstract not repeated in the body", (rd.match(/SampleCipher-\d+<\/h1>/g) ?? []).length === 1 && !rd.includes('id="abstract"'));
check("theorem block", rd.includes('<blockquote class="thm">'));
check("math left intact", rd.includes("$a_1 * b_2$") && rd.includes("$2^{-18}$"));
check("reference numbered and linked", /footnote-ref"><a href="#fn1" id="fnref1">\[1\]<\/a>/.test(rd) && rd.includes('id="references"'));
check("ePrint id linked", rd.includes('<a href="/2019/256">ePrint 2019/256</a>'));
check("no raw HTML", !rd.includes("<script>alert") && rd.includes("&lt;script&gt;"));
check("table", rd.includes("<table>"));
check("uploaded by on the reading page", rd.includes("Uploaded by"));
const raw = await new Client().req(`/${id}.md`, { headers: { accept: "*/*" } });
check("agents get the raw Markdown", raw.headers.get("content-type")?.startsWith("text/markdown") && (await raw.text()) === MD, raw.headers.get("content-type"));
const dl = await new Client().req(`/${id}.md?download`, { headers: { accept: "text/html" } });
check("download", /attachment/.test(dl.headers.get("content-disposition") ?? ""), dl.headers.get("content-disposition"));

console.log("\n# list and profile");
const list = await (await new Client().req("/manuscripts")).text();
check("in the list", list.includes(`href="/${id}"`) && list.includes(`Ada ${RUN}`));
const prof = pg.match(/href="(\/u\/[a-z2-7]{12})"/)?.[1];
const pp = await (await new Client().req(prof)).text();
check("on the uploader's profile", pp.includes(`href="/${id}"`) && pp.includes(`ms${RUN}`));

console.log("\n# numbering");
r = await me.req("/submit", { method: "POST", body: submitForm({ author: "B", title: "Second", abstract: "Two.", agree: "yes" }, { name: "b.md", text: "Just text." }) });
const id2 = (r.headers.get("location") ?? "").slice(1);
check("next number the same day", id2 === `${today}/${Number(id.split("/")[1]) + 1}`, `${id} then ${id2}`);
check("form fields win over the file", (await (await new Client().req(`/${id2}`)).text()).includes(">Second<"));

console.log("\n# removal");
r = await me.req("/manuscripts/remove", { method: "POST", body: new URLSearchParams({ id }), headers: { "content-type": "application/x-www-form-urlencoded" } });
check("members can't remove", r.status === 403, r.status);
const m = new Client();
await m.login(`maint${RUN}`, 4242);
r = await m.req("/manuscripts/remove", { method: "POST", body: new URLSearchParams({ id: `https://opencryptology.org/${id}` }), headers: { "content-type": "application/x-www-form-urlencoded" } });
check("maintainer removes (link accepted)", r.status === 200, r.status);
check("page is gone (410)", (await new Client().req(`/${id}`)).status === 410);
check(".md is gone (410)", (await new Client().req(`/${id}.md`)).status === 410);
check("out of the list", !(await (await new Client().req("/manuscripts")).text()).includes(`href="/${id}"`));

console.log("\n# other pages");
check("terms", /Acceptable use/.test(await (await new Client().req("/terms")).text()));
check("unknown id 404", (await new Client().req(`/${today}/9999`)).status === 404);
const ep = await new Client().req("/2024/1");
check("ePrint ids still work", ep.status === 301 && ep.headers.get("location") === "/2024/001", `${ep.status} ${ep.headers.get("location")}`);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
