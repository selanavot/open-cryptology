// TEMPORARY one-off prefill helper. POST /prefill with header x-prefill-key and a JSON body
// [{ id: "YYYY/NNNN", url: "https://raw.githubusercontent.com/..." | "https://web.archive.org/..." }].
// Only fetches from the community GitHub mirror and the Wayback Machine — never eprint.iacr.org.
// Every copy must be a complete PDF: some Wayback captures are cut off at 1 MiB (pdfcheck.ts).
import { completePdf } from "../../worker/src/pdfcheck";

interface Env { PDFS: R2Bucket; PREFILL_KEY: string }
const UA = "open-cryptology-prefill/0.1 (unofficial non-commercial ePrint mirror; copies public mirrors only)";
const MAX = 25 * 1024 * 1024;
const ALLOWED = [/^https:\/\/raw\.githubusercontent\.com\/arturo-kong\/IACR-eprint-mirror\//, /^https:\/\/web\.archive\.org\/web\/\d+id_\/https:\/\/eprint\.iacr\.org\//];
const ID_RE = /^\d{4}\/\d{1,6}$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/prefill") return new Response("not found", { status: 404 });
    const key = req.headers.get("x-prefill-key") ?? "";
    if (!env.PREFILL_KEY || key.length !== env.PREFILL_KEY.length || key !== env.PREFILL_KEY) return new Response("forbidden", { status: 403 });
    const items = (await req.json()) as { id: string; url: string }[];
    if (!Array.isArray(items) || items.length > 20) return new Response("bad request", { status: 400 });
    const out = [];
    for (const it of items) {
      if (!ID_RE.test(it.id) || !ALLOWED.some((r) => r.test(it.url))) { out.push({ id: it.id, ok: false, error: "rejected" }); continue; }
      try {
        const res = await fetch(it.url, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(45_000) });
        if (!res.ok) { out.push({ id: it.id, ok: false, status: res.status, error: `HTTP ${res.status}` }); continue; }
        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX) { out.push({ id: it.id, ok: false, error: "too large" }); continue; }
        const m = new Uint8Array(buf, 0, Math.min(5, buf.byteLength));
        if (String.fromCharCode(...m) !== "%PDF-") { out.push({ id: it.id, ok: false, error: "not a PDF" }); continue; }
        const c = await completePdf(buf, { suspectOneMiB: true });
        if (c.problem) { out.push({ id: it.id, ok: false, error: `not a PDF (incomplete: ${c.problem})` }); continue; }
        const obj = await env.PDFS.put(`pdf/${it.id}.pdf`, buf, { httpMetadata: { contentType: "application/pdf" }, customMetadata: { source_url: it.url } });
        out.push({ id: it.id, ok: true, size: buf.byteLength, etag: obj?.etag });
      } catch (e) {
        out.push({ id: it.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return Response.json(out);
  },
} satisfies ExportedHandler<Env>;
