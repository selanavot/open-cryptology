// Does the text of a PDF's first pages look like a given paper (title + authors)?
// Pure string code with no imports, shared by the Worker (verify.ts) and the offline benchmark
// pipeline/verify_bench.mjs, which runs this file directly under Node's type stripping, so keep
// to erasable TypeScript (no enums, namespaces or parameter properties). Calibrated on two samples
// of 300 real papers with that benchmark; rerun it after changing anything here.

/** The subset of a pdf.js text item that we use. */
export interface TextItem {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
  width?: number;
}

export interface MatchResult {
  ok: boolean;
  /** Best fraction of the title's significant words found together near the top of page 1 or 2. */
  titleScore: number;
  /** The author name that matched, if any. */
  authorHit: string | null;
  /** Set when pages 1-2 have no readable text layer. */
  noText?: boolean;
}

/** Fraction of significant title words needed. */
export const TITLE_THRESHOLD = 0.85;
/** The title must start within this many words of the top of page 1 or 2 (page 2: cover sheets).
 *  Without this, a paper citing the authors' earlier work by title on page 1-2 matched that work. */
export const TITLE_MAX_POS = 120;

/**
 * Join one page's text items. pdf.js items usually carry their own spaces, but some PDFs place
 * every word as a separate item with no space between them ("BinWang"); insert a space where the
 * next item starts visibly to the right of where the previous one ended, or on a new line.
 */
export function joinItems(items: TextItem[]): string {
  let out = "";
  let prevEnd: number | null = null;
  let prevY: number | null = null;
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    const t = it.transform;
    if (t && it.str && prevEnd !== null && prevY !== null && !/\s/.test(out[out.length - 1] ?? " ") && !/^\s/.test(it.str)) {
      const size = Math.hypot(t[2] ?? 0, t[3] ?? 0) || 10;
      const sameLine = Math.abs(t[5] - prevY) < size * 0.5;
      if (!sameLine) out += "\n";
      else if (t[4] - prevEnd > size * 0.15) out += " ";
    }
    out += it.str;
    if (it.hasEOL) out += "\n";
    if (t && it.str) {
      prevEnd = t[4] + (it.width ?? 0);
      prevY = t[5];
    }
  }
  return out;
}

/** Lowercase ASCII form: compatibility forms (ligatures, full-width) split, accents dropped. */
function fold(s: string): string {
  return s
    // Spacing accents, as old TeX PDFs place them next to the letter ("Padr´o"); NFKD would turn
    // them into a space and split the word.
    .replace(/[´`¨ˆ˜¸˛˝˘ˇ¯˙˚]/g, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/ø/g, "o")
    .replace(/[łđħı]/g, (c) => ({ ł: "l", đ: "d", ħ: "h", ı: "i" })[c] ?? c);
}

const words = (s: string) => s.replace(/[^a-z0-9]+/g, " ").trim();
const tokens = (s: string) => {
  const w = words(fold(s));
  return w ? w.split(" ") : [];
};
/** Footnote marks and line numbers glued to words ("Ghosh3", "ARADI1"). */
const stripDigits = (w: string) => w.replace(/^\d{1,3}(?=[a-z])|(?<=[a-z])\d{1,3}$/g, "");

/**
 * Old TeX PDFs (Computer Modern Type 1 fonts without a Unicode map) lose every lowercase "c" and
 * the ff/fi/fl ligatures in extracted text ("Se urity", "Cha ng"). Dropping the same letters from a
 * name or title word lets those still match; only used for longer words.
 */
const skeleton = (s: string) => s.replace(/ffi|ffl|ff|fi|fl/g, "").replace(/c/g, "");

const STOP = new Set(
  ("a an and are as at be based but by can for from has how in into is it its new not of on or our over " +
    "the their this to towards toward under using via vs we what when where which with without").split(" "),
);

/** Strip TeX from a title: math ($...$) is dropped (PDFs render it as symbols), accents kept. */
function untex(s: string): string {
  return s
    .replace(/\$[^$]*\$/g, " ")
    .replace(/\\['"^`~=.uvHc]\s*\{?([A-Za-z])\}?/g, "$1") // \'e, {\"o}, \v{s}
    .replace(/\\(ss|ae|oe|o|l|i)\b/gi, (_, c: string) => c)
    .replace(/\\[A-Za-z]+/g, " ") // \emph, \textsc, ...
    .replace(/&amp;/g, "&")
    .replace(/[{}]/g, "");
}

/**
 * Significant title words, each with its accepted spellings. A hyphenated or possessive word is
 * one word ("Multi-Party" -> "multiparty"): it matches "multiparty", "multi-party" and
 * "multi-\nparty" alike, because the PDF side is matched as runs of up to 4 adjacent tokens.
 */
export function titleWords(title: string): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  // ePrint titles often end in "(Full Version)", "(Extended Abstract)" etc., which the PDF lacks.
  const t = untex(title).replace(/\s*\([^()]*\b(version|abstract|full|extended|preliminary|revised|draft)\b[^()]*\)\s*$/i, "");
  for (const raw of t.split(/[\s/:;,.()[\]?!"“”]+/)) {
    const key = tokens(raw).join("");
    if (key.length < 3 || STOP.has(key) || seen.has(key)) continue;
    seen.add(key);
    const alts = new Set([key]);
    const sk = tokens(skeleton(raw)).join(""); // old TeX fonts, see skeleton()
    if (sk.length >= 4) alts.add(sk);
    if (key.length >= 5 && key.endsWith("s")) alts.add(key.slice(0, -1)); // "techniques" ~ "technique"
    out.push([...alts]);
  }
  return out;
}

const RUN = 4; // PDF tokens joined to match one title word
/** Title words found together: within a window of this many tokens (n = number of title words). */
const windowFor = (n: number) => 2 * n + 8;

/** Best fraction of title words found close together and near the top of a page. */
export function titleScore(pages: string[][], title: string, maxPos = TITLE_MAX_POS): number {
  const terms = titleWords(title);
  if (!terms.length) return 0;
  const index = new Map<string, number>();
  let maxLen = 0;
  terms.forEach((alts, i) => alts.forEach((a) => (index.set(a, i), (maxLen = Math.max(maxLen, a.length)))));
  const win = windowFor(terms.length);
  let best = 0;
  for (const tk of pages) {
    // hits[j] = [token position, term index], in position order.
    const hits: [number, number][] = [];
    const end = Math.min(tk.length, maxPos + win);
    for (let i = 0; i < end; i++) {
      let s = "";
      for (let k = 0; k < RUN && i + k < tk.length; k++) {
        s += tk[i + k];
        if (s.length > maxLen + 3) break;
        // Footnote marks and line numbers glue digits to words ("ARADI1"): also try without them.
        const d = stripDigits(s);
        const t = index.get(s) ?? index.get(d) ?? (d.length >= 5 && d.endsWith("s") ? index.get(d.slice(0, -1)) : undefined);
        if (t !== undefined) hits.push([i, t]);
      }
    }
    const count = new Array<number>(terms.length).fill(0);
    let distinct = 0;
    let lo = 0;
    for (let hi = 0; hi < hits.length; hi++) {
      if (count[hits[hi][1]]++ === 0) distinct++;
      while (hits[hi][0] - hits[lo][0] >= win) if (--count[hits[lo++][1]] === 0) distinct--;
      if (hits[lo][0] <= maxPos) best = Math.max(best, distinct);
    }
  }
  return best / terms.length;
}

/** Family-name particles ("De Santis", "van Tilborg"), joined to the part that follows them. */
const PARTICLES = new Set("da de del della der des di dos du la le van von ten ter".split(" "));

/**
 * Does any author's name appear on pages 1-2? A name matches if
 *  - its family name (the last part, as in the metadata; a compound one like "Liu-Zhang" or
 *    "De Santis" as a whole) appears as a word, needing 3+ letters; or
 *  - two parts of it appear next to each other in either order, or a part next to another part's
 *    initial: "Wei Li", "Li Wei", "W. Li", or "WANG Tao" for "Tao Wang". This is how 2-letter
 *    family names (Li, Wu, Xu) match; on their own they occur in any text.
 * The PDF side also counts runs of 2-3 adjacent words, so names split by kerning ("Dongho on")
 * or run together ("BinWang") still match. A given name on its own never counts.
 */
export function authorHit(pages: string[][], authors: string[]): string | null {
  const runs = new Set<string>(); // words, and 2- and 3-word runs joined without spaces
  const pairs = new Set<string>(); // "a b" for adjacent words
  for (const p of pages) {
    const tk = p.map(stripDigits);
    for (let i = 0; i < tk.length; i++) {
      runs.add(tk[i]);
      if (i + 1 < tk.length) {
        runs.add(tk[i] + tk[i + 1]);
        pairs.add(`${tk[i]} ${tk[i + 1]}`);
      }
      if (i + 2 < tk.length) runs.add(tk[i] + tk[i + 1] + tk[i + 2]);
    }
  }
  const adjacent = (a: string, b: string) => pairs.has(`${a} ${b}`) || pairs.has(`${b} ${a}`);
  for (const name of authors) {
    // "Chen-Da Liu-Zhang" -> chenda, liuzhang; "Fabrizio De Santis" -> fabrizio, desantis.
    const raw = name.split(/[\s,]+/).filter((r) => tokens(r).length);
    const units: { key: string; alt: string }[] = [];
    let particle = "";
    raw.forEach((r, i) => {
      const key = tokens(r).join("");
      if (i < raw.length - 1 && PARTICLES.has(key)) particle += key;
      else {
        units.push({ key: particle + key, alt: particle + tokens(skeleton(r)).join("") });
        particle = "";
      }
    });
    if (!units.length) continue;
    const last = units[units.length - 1];
    const bare = tokens(raw[raw.length - 1]).join(""); // "Tilborg" for "van Tilborg"
    if (last.key.length >= 3 && runs.has(last.key)) return name;
    if (bare.length >= 4 && runs.has(bare)) return name;
    if (last.alt.length >= 5 && runs.has(last.alt)) return name; // old TeX fonts, see skeleton()
    for (const u of units) {
      if (u.key.length < 2) continue;
      for (const v of units) if (v !== u && (adjacent(u.key, v.key) || adjacent(u.key, v.key[0]))) return name;
    }
    if (units.length >= 2) {
      const keys = units.map((u) => u.key);
      if (runs.has(keys.join("")) || runs.has(keys.reverse().join(""))) return name;
    }
  }
  return null;
}

/** False when pages 1-2 have no readable text (scans, or fonts without a Unicode map): such a
 *  file can never match automatically, which the reviewer should know. */
const COMMON = new Set("the and for with this that from which are".split(" "));
function readable(pages: string[][]): boolean {
  let n = 0;
  for (const p of pages) for (const w of p) if (COMMON.has(w) && ++n >= 10) return true;
  return false;
}

/** pageTexts: the extracted text of pages 1 and 2 (see joinItems). */
export function matchPaper(pageTexts: string[], title: string, authors: string[]): MatchResult {
  const pages = pageTexts.map(tokens);
  const score = titleScore(pages, title);
  const hit = authorHit(pages, authors);
  const r: MatchResult = { ok: score >= TITLE_THRESHOLD && !!hit, titleScore: Math.round(score * 100) / 100, authorHit: hit };
  if (!r.ok && !readable(pages)) r.noText = true;
  return r;
}
