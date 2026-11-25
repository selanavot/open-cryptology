// Authors' ORCID iDs and emails on original manuscripts (manuscripts.ts): given by the uploader,
// iDs shown, emails kept private. Run: npm --prefix worker test
import { test } from "node:test";
import assert from "node:assert/strict";
import { testWorker } from "./harness";
import { makePdf } from "./makepdf";
import { parseEmail, parseOrcid } from "../src/orcid";

const ADA = "0000-0002-1825-0097"; // ORCID's documented example iD
const pdf = (title = "On Lattices") => new File([makePdf({ pages: [[title, "Ada Lovelace"]] })], "paper.pdf", { type: "application/pdf" });

function webForm(rows: [string, string, string][], title = "On Lattices") {
  const fd = new FormData();
  fd.set("file", pdf(title));
  fd.set("title", title);
  for (const [name, orcid, email] of rows) {
    fd.append("author", name);
    fd.append("author_orcid", orcid);
    fd.append("author_email", email);
  }
  fd.set("abstract", "We study lattices.");
  fd.set("agree", "yes");
  return fd;
}

test("parseOrcid takes the iD however it's typed, and checks the check digit", () => {
  assert.equal(parseOrcid(ADA), ADA);
  assert.equal(parseOrcid(` https://orcid.org/${ADA}/ `), ADA);
  assert.equal(parseOrcid(`orcid.org/0000-0002-9079-593x`), "0000-0002-9079-593X");
  assert.equal(parseOrcid("0000-0002-1825-0098"), null, "wrong check digit");
  assert.equal(parseOrcid("Ada"), null);
  assert.equal(parseEmail(" Ada@Example.ORG "), "ada@example.org");
  assert.equal(parseEmail("ada at example"), null);
});

test("the web form stores iDs (shown) and emails (never shown)", async () => {
  const t = await testWorker();
  const me = await t.person({ name: "Ada Lovelace" });
  const r = await t.multipart(
    "/submit",
    webForm([
      ["Ada Lovelace", `https://orcid.org/${ADA}`, "Ada@Lovelace-Lab.test"],
      ["Claude Fable 5.2", "", ""],
      ["Bob Babbage", "", "bob@lovelace-lab.test"],
    ]),
    me,
  );
  assert.equal(r.status, 303, await r.clone().text());
  const id = r.headers.get("location")!.slice(1);
  const page = await t.text(`/${id}`);
  assert.match(page, new RegExp(`Ada Lovelace<a class="orcid-link" href="https://orcid.org/${ADA}"`));
  assert.match(page, /Claude Fable 5\.2, Bob Babbage<\/div>/);
  const j = (await (await t.get(`/api/manuscripts/${id}`)).json()) as Record<string, unknown>;
  assert.deepEqual(j.authors, ["Ada Lovelace", "Claude Fable 5.2", "Bob Babbage"]);
  assert.deepEqual(j.orcids, [ADA, null, null]);
  const emails = t.d1.rows<{ position: number; email: string }>("SELECT position, email FROM manuscript_author_emails WHERE manuscript_id = ?1 ORDER BY position", id);
  assert.deepEqual(emails, [{ position: 0, email: "ada@lovelace-lab.test" }, { position: 2, email: "bob@lovelace-lab.test" }]);
  // Emails appear nowhere public.
  for (const path of [`/${id}`, `/api/manuscripts/${id}`, "/api/manuscripts", "/manuscripts", `/u/${me.id}`, "/llms.txt"]) {
    assert.doesNotMatch(await t.text(path), /lovelace-lab/i, path);
  }
});

test("a manuscript without iDs looks as before", async () => {
  const t = await testWorker();
  const me = await t.person();
  const r = await t.multipart("/submit", webForm([["Ada Lovelace", "", ""]]), me);
  const id = r.headers.get("location")!.slice(1);
  assert.match(await t.text(`/${id}`), /<div class="ms-authors">Ada Lovelace<\/div>/);
  const j = (await (await t.get(`/api/manuscripts/${id}`)).json()) as Record<string, unknown>;
  assert.equal(j.orcids, null);
  assert.equal(t.d1.rows("SELECT * FROM manuscript_author_emails").length, 0);
});

test("bad iDs and emails are refused with a message naming the author, and the form keeps them", async () => {
  const t = await testWorker();
  const me = await t.person();
  let r = await t.multipart("/submit", webForm([["Ada Lovelace", "0000-0002-1825-0098", ""]]), me);
  assert.equal(r.status, 400);
  let h = await r.text();
  assert.match(h, /The ORCID iD for author 1 \(Ada Lovelace\) isn(?:'|&#39;)t valid/);
  assert.match(h, /value="0000-0002-1825-0098"/, "the form keeps what was typed");
  r = await t.multipart("/submit", webForm([["Ada Lovelace", "", ""], ["Bob", "", "bob at example"]]), me);
  h = await r.text();
  assert.match(h, /The email for author 2 \(Bob\) isn(?:'|&#39;)t valid/);
  r = await t.multipart("/submit", webForm([["Ada Lovelace", "", ""], ["", ADA, ""]]), me);
  assert.match(await r.text(), /Add a name for author 2/);
  assert.equal(t.d1.rows("SELECT * FROM manuscripts").length, 0);
});

test("agents give authors as names or as {name, orcid, email}", async () => {
  const t = await testWorker();
  const me = await t.person();
  const agent = await t.token(me);
  const fd = new FormData();
  fd.set("file", pdf());
  fd.set(
    "metadata",
    JSON.stringify({
      title: "On Lattices",
      authors: [{ name: "Ada Lovelace", orcid: ADA, email: "ada@example.org" }, "Claude Fable 5.2"],
      abstract: "We study lattices.",
      license: "CC-BY-4.0",
    }),
  );
  const r = await t.multipart("/api/manuscripts", fd, agent);
  assert.equal(r.status, 201, await r.clone().text());
  const j = (await r.json()) as { id: string; authors: string[]; orcids: unknown };
  assert.deepEqual(j.authors, ["Ada Lovelace", "Claude Fable 5.2"]);
  assert.deepEqual(j.orcids, [ADA, null]);
  assert.equal(t.d1.rows<{ email: string }>("SELECT email FROM manuscript_author_emails WHERE manuscript_id = ?1", j.id)[0].email, "ada@example.org");
  // Retrying the same post returns the same manuscript.
  const again = new FormData();
  again.set("file", pdf());
  again.set("metadata", fd.get("metadata") as string);
  const r2 = await t.multipart("/api/manuscripts", again, agent);
  assert.equal(r2.status, 200);
  assert.equal(((await r2.json()) as { duplicate: boolean }).duplicate, true);
  // Malformed entries are refused.
  const bad = new FormData();
  bad.set("file", pdf("Other"));
  bad.set("metadata", JSON.stringify({ title: "Other", authors: [{ name: "Ada", affiliation: "x" }], abstract: "a", license: "CC-BY-4.0" }));
  const rb = await t.multipart("/api/manuscripts", bad, agent);
  assert.equal(rb.status, 400);
  assert.match(((await rb.json()) as { message: string }).message, /"orcid", "email"/);
});
