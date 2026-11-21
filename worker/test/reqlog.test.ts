// The request log line (reqlog.ts). Run: npm --prefix worker test
import { test } from "node:test";
import assert from "node:assert/strict";
import { loggedQuery, requestLine } from "../src/reqlog";

test("query strings are logged, credential values are not", () => {
  assert.equal(loggedQuery(new URL("https://x.test/search?q=lattice+sigs&page=2")), "q=lattice+sigs&page=2");
  assert.equal(loggedQuery(new URL("https://x.test/auth/github/callback?code=abc123&state=xyz&next=%2F")), "code=REDACTED&state=REDACTED&next=%2F");
  assert.equal(loggedQuery(new URL("https://x.test/2024/123")), "");
});

test("request line carries the client, the address and the answer", () => {
  const u = new URL("https://opencryptology.org/2024/123.pdf?download=1");
  const req = new Request(u, {
    headers: {
      "user-agent": "curl/8.7.1",
      referer: "https://opencryptology.org/2024/123",
      "cf-connecting-ip": "203.0.113.7",
      range: "bytes=0-99",
      cookie: "oc_login=1; __Host-oc_session=abc",
    },
  });
  const res = new Response("x".repeat(100), { status: 206, headers: { "content-type": "application/pdf", "content-length": "100" } });
  const line = requestLine(req, u, res.status, 12, res);
  assert.deepEqual(
    { kind: line.kind, path: line.path, query: line.query, status: line.status, ms: line.ms, bytes: line.bytes, type: line.type },
    { kind: "request", path: "/2024/123.pdf", query: "download=1", status: 206, ms: 12, bytes: 100, type: "application/pdf" },
  );
  assert.equal(line.ip, "203.0.113.7");
  assert.equal(line.ref, "opencryptology.org");
  assert.equal(line.referer, "https://opencryptology.org/2024/123");
  assert.equal(line.range, true);
  assert.equal(line.signedIn, true);
  assert.ok(!JSON.stringify(line).includes("abc"), "the session cookie is never logged");
});

test("a request that threw still gets a line", () => {
  const u = new URL("https://opencryptology.org/2020/035.pdf");
  const line = requestLine(new Request(u), u, 500, 3);
  assert.equal(line.status, 500);
  assert.equal(line.bytes, undefined);
  assert.equal(line.signedIn, false);
});
