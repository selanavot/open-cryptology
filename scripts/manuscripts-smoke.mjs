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

/** A small valid one-page PDF. `catalog` adds entries to the document catalog; `objects` adds
 *  numbered objects from 5 up (for attachments). */
function makePdf(text, { catalog = "", objects = [] } = {}) {
  const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    `<< /Type /Catalog /Pages 2 0 R ${catalog} >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ...objects,
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
const PDF = makePdf(`SampleCipher ${RUN}`);
const WITH_ATTACHMENT = makePdf("With an attachment", {
  catalog: "/Names << /EmbeddedFiles << /Names [(attack.py) 5 0 R] >> >>",
  objects: ["<< /Type /Filespec /F (attack.py) /EF << /F 6 0 R >> >>", "<< /Type /EmbeddedFile /Length 5 >>\nstream\nprint\nendstream"],
});
const WITH_JS = makePdf("With a script", { catalog: "/OpenAction << /S /JavaScript /JS (app.alert(1)) >>" });

function submitForm(fields, file = { name: "paper.pdf", bytes: PDF }) {
  const fd = new FormData();
  if (file) fd.append("file", new Blob([file.bytes], { type: "application/pdf" }), file.name);
  for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) fd.append(k, x);
  return fd;
}
const FIELDS = { title: `A $2^{61}$ attack on 7-round SampleCipher-${RUN}`, abstract: "We attack 7 rounds in time $2^{61}$ with $a_1 * b_2$.", agree: "yes" };

const me = new Client();
await me.login(`ms${RUN}`, 1300000 + (RUN % 1e5));

console.log("\n# submit page");
let r = await new Client().req("/submit");
check("logged out: sent to log in", r.status === 303 && r.headers.get("location") === "/account?next=/submit", `${r.status} ${r.headers.get("location")}`);
r = await me.req("/submit");
const form = await r.text();
check("logged in: the form", r.status === 200 && /Submit an original manuscript/.test(form), r.status);
check("asks for a PDF", form.includes('accept="application/pdf,.pdf"'));
check("title, first author, abstract required", /id="sb-title"[^>]*required/.test(form) && /aria-label="Author 1"[^>]*required/.test(form) && /id="sb-abstract"[^>]*required/.test(form));

console.log("\n# validation");
const bad = async (name, fd, re) => {
  const x = await me.req("/submit", { method: "POST", body: fd });
  const t = await x.text();
  check(name, x.status === 400 && re.test(t), `${x.status} ${t.match(/role="alert">([^<]*)/)?.[1]}`);
};
await bad("no file", submitForm({ ...FIELDS, author: "A" }, null), /Choose a PDF/);
await bad("not a PDF", submitForm({ ...FIELDS, author: "A" }, { name: "x.pdf", bytes: new TextEncoder().encode("# Markdown") }), /isn&#39;t a PDF/);
await bad("truncated PDF", submitForm({ ...FIELDS, author: "A" }, { name: "x.pdf", bytes: PDF.slice(0, 200) }), /couldn&#39;t read that PDF/);
await bad("JavaScript refused", submitForm({ ...FIELDS, author: "A" }, { name: "js.pdf", bytes: WITH_JS }), /contains JavaScript/);
await bad("no title", submitForm({ ...FIELDS, title: "", author: "A" }), /Add a title/);
await bad("no authors", submitForm({ ...FIELDS }), /at least one author/);
await bad("no abstract", submitForm({ ...FIELDS, abstract: "", author: "A" }), /Add an abstract/);
await bad("no agreement", submitForm({ ...FIELDS, agree: "", author: "A" }), /agree to the terms/);
r = await me.req("/submit", { method: "POST", body: submitForm({ ...FIELDS, author: "A" }), origin: "https://evil.example" });
check("cross-site post refused", r.status === 403, r.status);

console.log("\n# publish");
r = await me.req("/submit", { method: "POST", body: submitForm({ ...FIELDS, author: ["Claude Fable 5.2", "  ", `Ada ${RUN}`] }) });
const loc = r.headers.get("location") ?? "";
check("published, redirected to /YYYY-MM-DD/N", r.status === 303 && /^\/\d{4}-\d{2}-\d{2}\/\d+$/.test(loc), `${r.status} ${loc}`);
const id = loc.slice(1);
const today = new Date().toISOString().slice(0, 10);
check("id is today's UTC date", id.startsWith(today + "/"), id);

console.log("\n# manuscript page");
const pg = await (await new Client().req(`/${id}`)).text();
check("title", pg.includes(`SampleCipher-${RUN}`) && pg.includes("$2^{61}$"));
check("authors, blank ones dropped", pg.includes(`Claude Fable 5.2, Ada ${RUN}`));
check("uploaded by, with the profile link", /Uploaded by <a class="ms-person" href="\/u\/[a-z2-7]{12}"/.test(pg));
check("abstract, math left for KaTeX", pg.includes("$a_1 * b_2$"));
check("Cite as", pg.includes(`Open Cryptology ${id}`));
check("BibTeX, one braced entry per author", pg.includes(`author       = {{Claude Fable 5.2} and {Ada ${RUN}}}`));
check("PDF button", pg.includes(`href="/${id}.pdf"`) && /PDF<\/a>/.test(pg));
check("Scholar tags", pg.includes('name="citation_title"') && (pg.match(/name="citation_author"/g) ?? []).length === 2 && pg.includes('name="citation_pdf_url"'));

console.log("\n# the PDF");
const file = await new Client().req(`/${id}.pdf`);
const got = new Uint8Array(await file.arrayBuffer());
check("served as application/pdf, inline", file.headers.get("content-type") === "application/pdf" && /^inline;/.test(file.headers.get("content-disposition") ?? ""), file.headers.get("content-type"));
check("same bytes", got.length === PDF.length && got.every((b, i) => b === PDF[i]), `${got.length} vs ${PDF.length}`);
const etag = file.headers.get("etag");
check("304 on a matching ETag", !!etag && (await new Client().req(`/${id}.pdf`, { headers: { "if-none-match": etag } })).status === 304);

console.log("\n# attachments are fine now");
r = await me.req("/submit", { method: "POST", body: submitForm({ ...FIELDS, title: "With an attachment", author: "B" }, { name: "att.pdf", bytes: WITH_ATTACHMENT }) });
check("PDF with an embedded file is published", r.status === 303, `${r.status} ${(await r.text()).match(/role="alert">([^<]*)/)?.[1] ?? ""}`);
const id2 = (r.headers.get("location") ?? "").slice(1);
check("next number the same day", id2 === `${today}/${Number(id.split("/")[1]) + 1}`, `${id} then ${id2}`);

console.log("\n# list and profile");
const list = await (await new Client().req("/manuscripts")).text();
check("in the list", list.includes(`href="/${id}"`) && list.includes(`Ada ${RUN}`));
const prof = pg.match(/href="(\/u\/[a-z2-7]{12})"/)?.[1];
const pp = prof ? await (await new Client().req(prof)).text() : "";
check("on the uploader's profile", pp.includes(`href="/${id}"`) && pp.includes(`ms${RUN}`));

console.log("\n# removal");
r = await me.req("/manuscripts/remove", { method: "POST", body: new URLSearchParams({ id }), headers: { "content-type": "application/x-www-form-urlencoded" } });
check("members can't remove", r.status === 403, r.status);
const m = new Client();
await m.login(`maint${RUN}`, 4242);
r = await m.req("/manuscripts/remove", { method: "POST", body: new URLSearchParams({ id: `https://opencryptology.org/${id}.pdf` }), headers: { "content-type": "application/x-www-form-urlencoded" } });
check("maintainer removes (link accepted)", r.status === 200, r.status);
check("page is gone (410)", (await new Client().req(`/${id}`)).status === 410);
check("PDF is gone (410)", (await new Client().req(`/${id}.pdf`)).status === 410);
check("out of the list", !(await (await new Client().req("/manuscripts")).text()).includes(`href="/${id}"`));

console.log("\n# other pages");
check("terms", /Acceptable use/.test(await (await new Client().req("/terms")).text()));
check("unknown id 404", (await new Client().req(`/${today}/9999`)).status === 404);
check(".md is not a manuscript path any more", (await new Client().req(`/${id2}.md`)).status === 404);
const ep = await new Client().req("/2024/1");
check("ePrint ids still work", ep.status === 301 && ep.headers.get("location") === "/2024/001", `${ep.status} ${ep.headers.get("location")}`);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
