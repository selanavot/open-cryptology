// Is this a complete PDF? Shared by the upload path (uploadguard.ts, verify.ts) and the copy
// helpers (versions-worker/, prefill-worker/), which import this file by relative path.
//
// Why: some Wayback Machine captures of ePrint PDFs were cut off at crawl time at exactly 1 MiB
// (1,048,576 bytes; the archived payload itself is short, its CDX digest matches the short
// bytes). A cut-off PDF still starts with %PDF-, so a header check accepts it, and pdf.js
// rebuilds the cross-reference table well enough to report a page count. What it lacks is the
// end of the file: the trailer, `startxref` and `%%EOF`.

import { getDocumentProxy } from "unpdf";

/** Size at which Wayback truncated captures; a "complete" file of exactly this size is suspect. */
export const TRUNCATED_CAPTURE_SIZE = 1024 * 1024;

const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

export interface IntegrityOptions {
  /** Reject files of exactly 1 MiB (set where the bytes come from Wayback captures). */
  suspectOneMiB?: boolean;
}

/** Cheap byte-level check. Returns a short reason the file is not a complete PDF, or null.
 *  Requires the %PDF- header, a `startxref <offset>` followed by `%%EOF` in the last 2 KiB (real
 *  files sometimes carry a few bytes of padding after %%EOF), and an offset inside the file. */
export function pdfIntegrity(buf: ArrayBuffer, opts: IntegrityOptions = {}): string | null {
  const bytes = new Uint8Array(buf);
  if (bytes.length < 32 || latin1(bytes.subarray(0, 5)) !== "%PDF-") return "no %PDF- header";
  if (opts.suspectOneMiB && bytes.length === TRUNCATED_CAPTURE_SIZE) return "exactly 1 MiB, a truncated capture";
  const tail = latin1(bytes.subarray(Math.max(0, bytes.length - 2048)));
  if (!tail.includes("%%EOF")) return "truncated: no %%EOF end-of-file marker";
  const m = [...tail.matchAll(/startxref\s+(\d+)\s+%%EOF/g)].pop();
  if (!m) return "truncated: no startxref before %%EOF";
  if (Number(m[1]) >= bytes.length) return "truncated: xref offset past the end of the file";
  return null;
}

/** Page count from pdf.js, or a reason it could not be read. 0 pages counts as unreadable. */
export async function pageCount(buf: ArrayBuffer): Promise<{ pages: number; error?: string }> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | null = null;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buf.slice(0))); // pdf.js detaches what it is given
    const pages = pdf.numPages;
    return pages > 0 ? { pages } : { pages: 0, error: "no pages" };
  } catch (e) {
    return { pages: 0, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await pdf?.loadingTask.destroy().catch(() => {});
  }
}

/** Both checks: what the copy helpers require before storing a PDF. */
export async function completePdf(buf: ArrayBuffer, opts: IntegrityOptions = {}): Promise<{ pages: number; problem?: string }> {
  const problem = pdfIntegrity(buf, opts);
  if (problem) return { pages: 0, problem };
  const pc = await pageCount(buf);
  return pc.error ? { pages: 0, problem: `unreadable: ${pc.error.slice(0, 120)}` } : { pages: pc.pages };
}
