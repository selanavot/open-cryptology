import { getDocumentProxy } from "unpdf";
import { joinItems, matchPaper, type TextItem } from "./match";
import { pdfIntegrity } from "./pdfcheck";

// Instant upload verification: does this PDF look like the paper it was uploaded for?
// Extract the text of the first two pages and require most of the title's words together near the
// top of a page, plus an author's name (matching rules: match.ts, measured with
// pipeline/verify_bench.mjs). Passing uploads are published immediately; others stay in quarantine
// for review. The same parse also looks for active content (scripts, attachments) that the
// raw-byte scan in uploadguard.ts can't see inside compressed object streams.
// Only pages 1-2 are read, so pdf.js would happily verify a file that is cut off after them (it
// rebuilds a damaged cross-reference table): the end of the file is checked first (pdfcheck.ts).

export interface VerifyReport {
  ok: boolean;
  titleScore: number; // fraction of significant title words found together near the top of page 1 or 2
  authorHit: string | null; // first author name found, if any
  pages: number;
  /** Pages 1-2 have no readable text (scan, or fonts without a Unicode map). */
  noText?: boolean;
  /** Set when the PDF carries active content; the upload must be rejected. */
  active?: string;
  error?: string;
}

/** Only these pages are read: the title and authors are on page 1 (2 for cover sheets). */
const TEXT_PAGES = 2;

type Doc = Awaited<ReturnType<typeof getDocumentProxy>>;

/** Document-level scripts, attachments or XFA forms: things a paper never needs. */
async function activeContent(pdf: Doc): Promise<string | null> {
  if (await pdf.getJSActions()) return "scripts";
  if (await pdf.getAttachments()) return "embedded files";
  if (pdf.isPureXfa) return "XFA forms";
  return null;
}

export async function verifyPdf(buf: ArrayBuffer, title: string, authors: string[]): Promise<VerifyReport> {
  const incomplete = pdfIntegrity(buf);
  if (incomplete) return { ok: false, titleScore: 0, authorHit: null, pages: 0, error: incomplete };
  let pdf: Doc | null = null;
  try {
    // pdf.js takes ownership of (detaches) the buffer it is given, so hand it a copy.
    pdf = await getDocumentProxy(new Uint8Array(buf.slice(0)));
    const pages = pdf.numPages;
    if (pages < 1) return { ok: false, titleScore: 0, authorHit: null, pages, error: "no pages" };
    const active = await activeContent(pdf);
    if (active) return { ok: false, titleScore: 0, authorHit: null, pages, active };

    const texts: string[] = [];
    for (let i = 1; i <= Math.min(TEXT_PAGES, pages); i++) {
      const page = await pdf.getPage(i);
      if (await page.getJSActions()) return { ok: false, titleScore: 0, authorHit: null, pages, active: "scripts" };
      const tc = await page.getTextContent();
      texts.push(joinItems(tc.items as TextItem[]));
      page.cleanup();
    }
    return { ...matchPaper(texts, title, authors), pages };
  } catch (e) {
    return { ok: false, titleScore: 0, authorHit: null, pages: 0, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await pdf?.loadingTask.destroy().catch(() => {});
  }
}
