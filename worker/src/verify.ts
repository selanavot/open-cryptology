import { getDocumentProxy } from "unpdf";

// Instant upload verification: does this PDF look like the paper it was uploaded for?
// Extract the text of the first two pages and require (a) most of the title's words and
// (b) at least one author surname. Passing uploads are published immediately; others stay in
// quarantine for review. The same parse also looks for active content (scripts, attachments)
// that the raw-byte scan in uploadguard.ts can't see inside compressed object streams.

export interface VerifyReport {
  ok: boolean;
  titleScore: number; // fraction of significant title words found on pages 1-2
  authorHit: string | null; // first author surname found, if any
  pages: number;
  /** Set when the PDF carries active content; the upload must be rejected. */
  active?: string;
  error?: string;
}

const TITLE_THRESHOLD = 0.85;
/** Only these pages are read: the title and authors are on page 1 (2 for cover sheets). */
const TEXT_PAGES = 2;

const norm = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .toLowerCase()
    .replace(/\$[^$]*\$/g, " ") // drop inline TeX from titles
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function titleWords(title: string): string[] {
  return [...new Set(norm(title).split(" ").filter((w) => w.length > 2))];
}

function surname(name: string): string | null {
  const parts = norm(name).split(" ").filter(Boolean);
  const last = parts[parts.length - 1];
  return last && last.length >= 3 ? last : null;
}

type Doc = Awaited<ReturnType<typeof getDocumentProxy>>;

/** Document-level scripts, attachments or XFA forms: things a paper never needs. */
async function activeContent(pdf: Doc): Promise<string | null> {
  if (await pdf.getJSActions()) return "scripts";
  if (await pdf.getAttachments()) return "embedded files";
  if (pdf.isPureXfa) return "XFA forms";
  return null;
}

export async function verifyPdf(buf: ArrayBuffer, title: string, authors: string[]): Promise<VerifyReport> {
  let pdf: Doc | null = null;
  try {
    // pdf.js takes ownership of (detaches) the buffer it is given, so hand it a copy.
    pdf = await getDocumentProxy(new Uint8Array(buf.slice(0)));
    const pages = pdf.numPages;
    const active = await activeContent(pdf);
    if (active) return { ok: false, titleScore: 0, authorHit: null, pages, active };

    const texts: string[] = [];
    for (let i = 1; i <= Math.min(TEXT_PAGES, pages); i++) {
      const page = await pdf.getPage(i);
      if (await page.getJSActions()) return { ok: false, titleScore: 0, authorHit: null, pages, active: "scripts" };
      const tc = await page.getTextContent();
      // Joined the way unpdf's extractText does it (items carry their own spaces).
      texts.push(tc.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : "")).join(""));
      page.cleanup();
    }
    const hay = ` ${norm(texts.join(" "))} `;
    const words = titleWords(title);
    const found = words.filter((w) => hay.includes(` ${w} `)).length;
    const titleScore = words.length ? found / words.length : 0;
    const authorHit = authors.map(surname).find((s) => s && hay.includes(` ${s} `)) ?? null;
    return { ok: titleScore >= TITLE_THRESHOLD && !!authorHit, titleScore: Math.round(titleScore * 100) / 100, authorHit, pages };
  } catch (e) {
    return { ok: false, titleScore: 0, authorHit: null, pages: 0, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await pdf?.loadingTask.destroy().catch(() => {});
  }
}
