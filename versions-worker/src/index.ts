// TEMPORARY version-history helper (see wrangler.jsonc). Two endpoints, both POST + x-versions-key:
//   /hash  [{ id, key }]                       -> sha256/sha1/size of objects already in R2
//   /copy  [{ id, url, key, skip?: sha256[] }] -> fetch a public copy, verify it is a PDF, hash
//          it; if its sha256 is in `skip` (content we already hold) nothing is written, else it
//          is stored at `key` (which must be pdf/<id>/<stamp>.pdf).
// Only the community GitHub mirror and Wayback `id_` replays of eprint.iacr.org PDFs are fetched.
interface Env { PDFS: R2Bucket; VERSIONS_KEY: string }
const UA = "open-cryptology-versions/0.1 (unofficial non-commercial ePrint mirror; copies public mirrors only)";
const MAX = 50 * 1024 * 1024;
const ALLOWED = [
  /^https:\/\/raw\.githubusercontent\.com\/arturo-kong\/IACR-eprint-mirror\//,
  /^https:\/\/web\.archive\.org\/web\/\d{14}id_\/https?:\/\/(www\.)?eprint\.iacr\.org(:\d+)?\/\d{4}\/\d+\.pdf$/,
];
const ID_RE = /^\d{4}\/\d{1,6}$/;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
function base32(b: ArrayBuffer): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let val = 0;
  let out = "";
  for (const byte of new Uint8Array(b)) {
    val = ((val << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += A[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}
async function hashes(buf: ArrayBuffer) {
  const [s256, s1] = await Promise.all([crypto.subtle.digest("SHA-256", buf), crypto.subtle.digest("SHA-1", buf)]);
  return { sha256: hex(s256), sha1: base32(s1), size: buf.byteLength };
}
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST") return new Response("not found", { status: 404 });
    const key = req.headers.get("x-versions-key") ?? "";
    if (!env.VERSIONS_KEY || key.length !== env.VERSIONS_KEY.length || key !== env.VERSIONS_KEY) {
      return new Response("forbidden", { status: 403 });
    }
    const items = (await req.json()) as { id: string; key: string; url?: string; skip?: string[] }[];
    if (!Array.isArray(items) || items.length > 20) return new Response("bad request", { status: 400 });
    const out: Record<string, unknown>[] = [];

    if (url.pathname === "/hash") {
      for (const it of items) {
        try {
          if (!ID_RE.test(it.id) || !it.key.startsWith(`pdf/${it.id}`)) throw new Error("rejected");
          const obj = await env.PDFS.get(it.key);
          if (!obj) {
            out.push({ id: it.id, key: it.key, ok: false, error: "missing" });
            continue;
          }
          out.push({ id: it.id, key: it.key, ok: true, ...(await hashes(await obj.arrayBuffer())) });
        } catch (e) {
          out.push({ id: it.id, key: it.key, ok: false, error: err(e) });
        }
      }
      return Response.json(out);
    }

    if (url.pathname === "/copy") {
      for (const it of items) {
        try {
          const keyRe = new RegExp(`^pdf/${it.id.replace("/", "\\/")}/\\d{8}T\\d{6}Z\\.pdf$`);
          if (!ID_RE.test(it.id) || !it.url || !ALLOWED.some((r) => r.test(it.url!)) || !keyRe.test(it.key)) {
            out.push({ id: it.id, key: it.key, ok: false, error: "rejected" });
            continue;
          }
          const res = await fetch(it.url, {
            headers: { "user-agent": UA },
            redirect: "follow",
            signal: AbortSignal.timeout(60_000),
          });
          if (!res.ok) {
            out.push({ id: it.id, key: it.key, ok: false, status: res.status, error: `HTTP ${res.status}` });
            continue;
          }
          if (Number(res.headers.get("content-length") ?? "0") > MAX) {
            out.push({ id: it.id, key: it.key, ok: false, error: "too large" });
            continue;
          }
          const buf = await res.arrayBuffer();
          if (buf.byteLength > MAX) {
            out.push({ id: it.id, key: it.key, ok: false, error: "too large" });
            continue;
          }
          if (String.fromCharCode(...new Uint8Array(buf, 0, Math.min(5, buf.byteLength))) !== "%PDF-") {
            out.push({ id: it.id, key: it.key, ok: false, error: "not a PDF" });
            continue;
          }
          const h = await hashes(buf);
          if (it.skip?.includes(h.sha256)) {
            out.push({ id: it.id, key: it.key, ok: true, dup: true, ...h });
            continue;
          }
          await env.PDFS.put(it.key, buf, {
            httpMetadata: { contentType: "application/pdf" },
            customMetadata: { paper_id: it.id, source_url: it.url, sha256: h.sha256 },
            sha256: h.sha256,
          });
          out.push({ id: it.id, key: it.key, ok: true, stored: true, ...h });
        } catch (e) {
          out.push({ id: it.id, key: it.key, ok: false, error: err(e) });
        }
      }
      return Response.json(out);
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
