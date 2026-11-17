// PDF checks used on every upload (uploadguard.ts, verify.ts), run against the real pdf.js
// from unpdf. Run: npm --prefix worker test
import { test } from "node:test";
import assert from "node:assert/strict";
import { completePdf, pdfIntegrity, TRUNCATED_CAPTURE_SIZE } from "../src/pdfcheck";
import { activeContentScan, scanPdf } from "../src/uploadguard";
import { inspectPdf, verifyPdf } from "../src/verify";
import { latin1Bytes, makePdf } from "./makepdf";

const text = (b: ArrayBuffer) => new TextDecoder("latin1").decode(b);

const TITLE = "Succinct Arguments from Lattice Commitments";
const AUTHORS = ["Ada Lovelace", "Alan Turing"];
const paper = () =>
  makePdf({
    pages: [
      [TITLE, "Ada Lovelace and Alan Turing", "Abstract. We build succinct arguments."],
      ["1 Introduction", "Body text."],
    ],
  });

test("pdfIntegrity: a complete PDF passes", () => {
  assert.equal(pdfIntegrity(paper()), null);
});

test("pdfIntegrity: padding after %%EOF is fine", () => {
  assert.equal(pdfIntegrity(latin1Bytes(text(paper()) + "\n\n\0\0\0\n")), null);
});

test("pdfIntegrity: rejects a file without the %PDF- header", () => {
  assert.equal(pdfIntegrity(latin1Bytes("<html>" + text(paper()))), "no %PDF- header");
  assert.equal(pdfIntegrity(new ArrayBuffer(0)), "no %PDF- header");
});

test("pdfIntegrity: rejects a file cut off before its end", () => {
  const b = paper();
  assert.match(pdfIntegrity(b.slice(0, Math.floor(b.byteLength / 2))) ?? "", /^truncated/);
});

test("pdfIntegrity: rejects an xref offset past the end of the file", () => {
  const s = text(paper()).replace(/startxref\n\d+/, "startxref\n99999999");
  assert.equal(pdfIntegrity(latin1Bytes(s)), "truncated: xref offset past the end of the file");
});

test("pdfIntegrity: exactly 1 MiB is suspect only where asked (Wayback captures)", () => {
  // Pad with a comment line before the xref table, moving the startxref offset to match.
  const s = text(paper());
  const body = s.slice(0, s.indexOf("xref\n"));
  const padded = (n: number) =>
    body + "%" + "x".repeat(n - 2) + "\n" + s.slice(body.length).replace(/startxref\n(\d+)/, (_, x: string) => `startxref\n${Number(x) + n}`);
  let n = TRUNCATED_CAPTURE_SIZE - s.length;
  n -= padded(n).length - TRUNCATED_CAPTURE_SIZE; // the offset gained digits
  const oneMiB = latin1Bytes(padded(n));
  assert.equal(oneMiB.byteLength, TRUNCATED_CAPTURE_SIZE);
  assert.equal(pdfIntegrity(oneMiB), null);
  assert.equal(pdfIntegrity(oneMiB, { suspectOneMiB: true }), "exactly 1 MiB, a truncated capture");
});

test("completePdf: counts pages of a readable PDF", async () => {
  assert.deepEqual(await completePdf(paper()), { pages: 2 });
  assert.deepEqual(await completePdf(makePdf({ pages: [["a"], ["b"], ["c"]] })), { pages: 3 });
});

test("completePdf: a well-formed tail on garbage is unreadable", async () => {
  const junk = latin1Bytes("%PDF-1.7\n" + "garbage ".repeat(64) + "\nstartxref\n9\n%%EOF\n");
  assert.equal(pdfIntegrity(junk), null);
  const r = await completePdf(junk);
  assert.equal(r.pages, 0);
  assert.ok(r.problem, "expected a problem");
});

test("scanPdf: wraps integrity problems in a message for people", () => {
  assert.equal(scanPdf(paper()), null);
  assert.match(scanPdf(paper().slice(0, 100)) ?? "", /incomplete or damaged/);
});

test("activeContentScan: flags scripts, launch actions and XFA; allows attachments", () => {
  const withRaw = (s: string) => latin1Bytes(text(paper()) + s);
  assert.equal(activeContentScan(paper()), null);
  assert.equal(activeContentScan(withRaw("<< /S /JavaScript /JS (app.alert(1)) >>")), "JavaScript");
  assert.equal(activeContentScan(withRaw("<< /JS (x) >>")), "JavaScript");
  assert.equal(activeContentScan(withRaw("<< /JS 12 0 R >>")), "JavaScript");
  assert.equal(activeContentScan(withRaw("<< /S /J#61vaScript >>")), "JavaScript");
  assert.equal(activeContentScan(withRaw("<< /S /Launch /F (calc.exe) >>")), "launch action");
  assert.equal(activeContentScan(withRaw("<< /XFA 5 0 R >>")), "XFA form");
  assert.equal(activeContentScan(withRaw("<< /EmbeddedFiles 7 0 R >>")), null);
});

test("inspectPdf: a clean PDF has pages and no active content", async () => {
  assert.deepEqual(await inspectPdf(paper()), { pages: 2 });
});

test("inspectPdf: finds a document-level script", async () => {
  const pdf = makePdf({
    catalogExtra: "/OpenAction 8 0 R",
    extraObjects: () => ["<< /Type /Action /S /JavaScript /JS (app.alert(1)) >>"],
  });
  assert.equal((await inspectPdf(pdf)).active, "JavaScript");
});

test("inspectPdf: reports damage instead of throwing", async () => {
  assert.match((await inspectPdf(paper().slice(0, 200))).problem ?? "", /^truncated/);
});

test("verifyPdf: matches the right paper", async () => {
  const r = await verifyPdf(paper(), TITLE, AUTHORS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.pages, 2);
  assert.ok(r.titleScore >= 0.75);
  assert.ok(r.authorHit);
});

test("verifyPdf: does not match another paper", async () => {
  const r = await verifyPdf(paper(), "Fully Homomorphic Encryption over the Integers", ["Craig Gentry"]);
  assert.equal(r.ok, false);
  assert.equal(r.pages, 2);
});

test("verifyPdf: rejects a truncated file before parsing it", async () => {
  const r = await verifyPdf(paper().slice(0, 300), TITLE, AUTHORS);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /^truncated/);
});
