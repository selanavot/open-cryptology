// Production hardening: body-size cap, base headers, search prefix floor, PDF storage errors.
// Run: npm --prefix worker test
import { test } from "node:test";
import assert from "node:assert/strict";
import { bodyTooLarge, withBaseHeaders } from "../src/index";
import { toFtsQuery, type Env } from "../src/db";
import { servePdf } from "../src/paper";

const post = (path: string, bytes: number) =>
  new Request(`https://opencryptology.org${path}`, { method: "POST", headers: { "content-length": String(bytes) } });

test("small-body routes refuse bodies over 1 MB; upload routes check their own limits", () => {
  assert.equal(bodyTooLarge(post("/contact", 5000), "/contact"), null);
  assert.equal(bodyTooLarge(post("/contact", 2 << 20), "/contact")?.status, 413);
  assert.equal(bodyTooLarge(post("/comments", 2 << 20), "/comments")?.status, 413);
  for (const p of ["/2024/123/upload", "/api/upload/2024/123", "/api/manuscripts", "/api/manuscripts/2026-11-01/3", "/submit", "/2026-11-01/3"]) {
    assert.equal(bodyTooLarge(post(p, 40 << 20), p), null, p);
  }
  assert.equal(bodyTooLarge(new Request("https://opencryptology.org/"), "/"), null);
});

test("HSTS and nosniff on https responses, even immutable ones", () => {
  const r = withBaseHeaders(new Response("x", { headers: { "content-type": "text/plain" } }), true);
  assert.equal(r.headers.get("strict-transport-security"), "max-age=31536000");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const redirect = withBaseHeaders(Response.redirect("https://opencryptology.org/", 301), true);
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get("strict-transport-security"), "max-age=31536000");
  assert.equal(withBaseHeaders(new Response("x"), false).headers.has("strict-transport-security"), false);
});

test("prefix search needs 3+ characters before the *", () => {
  assert.equal(toFtsQuery("lat*"), '"lat"*');
  assert.equal(toFtsQuery("a*"), '"a"');
  assert.equal(toFtsQuery("ab* lattice"), '"ab" "lattice"');
});

function fakeEnv(pdfs: Partial<R2Bucket>): Env {
  const paper = { id: "2024/123", pdf_key: "pdfs/2024/123.pdf", pdf_sha256: "ab", pdf_size: 10, pdf_source_date: "2024-01-01", license_code: null, withdrawn: 0 };
  const db = { prepare: () => ({ bind: () => ({ first: async () => paper }) }) };
  return { DB: db, PDFS: pdfs, ORIGIN_BASE: "https://eprint.iacr.org", SITE_URL: "https://opencryptology.org" } as unknown as Env;
}

test("an R2 failure answers 503 with Retry-After, not an unhandled 500", async () => {
  const boom = async () => {
    throw new Error("head: We encountered an internal error. Please try again. (10001)");
  };
  const env = fakeEnv({ get: boom, head: boom } as unknown as Partial<R2Bucket>);
  const err = console.error;
  console.error = () => {};
  try {
    for (const init of [{ method: "HEAD" }, { method: "GET", headers: { range: "bytes=0-9" } }]) {
      const res = await servePdf(env, new Request("https://opencryptology.org/2024/123.pdf", init), 2024, 123);
      assert.equal(res.status, 503, init.method);
      assert.equal(res.headers.get("retry-after"), "60");
    }
  } finally {
    console.error = err;
  }
});
