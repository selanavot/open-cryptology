import { extractText, getDocumentProxy } from "unpdf";

// Instant upload verification: does this PDF look like the paper it was uploaded for?
// Extract the text of the first two pages and require (a) most of the title's words and
// (b) at least one author surname. Passing uploads are published immediately; others stay in
// quarantine for review.

export interface VerifyReport {
  ok: boolean;
  titleScore: number; // fraction of significant title words found on pages 1-2
  authorHit: string | null; // first author surname found, if any
  pages: number;
  error?: string;
}

const TITLE_THRESHOLD = 0.85;

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

export async function verifyPdf(buf: ArrayBuffer, title: string, authors: string[]): Promise<VerifyReport> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buf.slice(0)));
    const pages = pdf.numPages;
    const { text } = await extractText(pdf, { mergePages: false });
    const first = norm((text as string[]).slice(0, 2).join(" "));
    const hay = ` ${first} `;
    const words = titleWords(title);
    const found = words.filter((w) => hay.includes(` ${w} `)).length;
    const titleScore = words.length ? found / words.length : 0;
    const authorHit = authors.map(surname).find((s) => s && hay.includes(` ${s} `)) ?? null;
    return { ok: titleScore >= TITLE_THRESHOLD && !!authorHit, titleScore: Math.round(titleScore * 100) / 100, authorHit, pages };
  } catch (e) {
    return { ok: false, titleScore: 0, authorHit: null, pages: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
