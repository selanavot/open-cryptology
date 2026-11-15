// Markdown for original manuscripts (docs: llms.txt, "How to format a manuscript").
// - No raw HTML: anything in angle brackets is shown as text, so a manuscript can't inject markup.
// - Math: $...$ and $$...$$ pass through untouched (KaTeX renders them in the browser), so `_` and
//   `*` inside formulas never turn into emphasis.
// - `## ` headings get ids and numbers ("2 Methodology") and make up the contents list; a leading
//   `# Title` and an `## Abstract` section are dropped from the body (the page shows them already).
// - `> **Theorem 1.** ...` (also Lemma, Definition, ...) blockquotes become theorem blocks.
// - References are footnotes with named keys, `[^kolbl15]`, numbered by first use, with links both
//   ways; "ePrint 2024/123" links to our page for that paper.
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type Token from "markdown-it/lib/token.mjs";

export interface Rendered {
  html: string;
  toc: { id: string; text: string }[];
}

const THEOREM_RE = /^(Theorem|Lemma|Proposition|Corollary|Definition|Claim|Conjecture|Remark|Example|Assumption)\b/;
const UNNUMBERED = /^(references|bibliography|acknowledg(e)?ments?|appendix\b|abstract)$/i;
const EPRINT_RE = /\bePrint (\d{4})\/(\d{1,6})\b/g;

/** $...$ and $$...$$ as opaque text, so markdown leaves formulas alone. */
function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  if (src[start] !== "$") return false;
  const delim = src[start + 1] === "$" ? "$$" : "$";
  let end = start + delim.length;
  while ((end = src.indexOf(delim, end)) !== -1) {
    if (src[end - 1] !== "\\") break;
    end += 1;
  }
  if (end === -1 || end === start + delim.length) return false;
  if (!silent) {
    const t = state.push("math_inline", "", 0);
    t.content = src.slice(start, end + delim.length);
  }
  state.pos = end + delim.length;
  return true;
}

const slug = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "section";

function makeRenderer(toc: Rendered["toc"]): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  md.use(footnote as unknown as Parameters<MarkdownIt["use"]>[0]); // the plugin's types lag markdown-it's
  md.inline.ruler.before("escape", "math_inline", mathInline);
  md.renderer.rules.math_inline = (tokens, i) => md.utils.escapeHtml(tokens[i].content);
  // Footnotes: keep the [n] label, but drop the <hr> above the list (the References heading does that job).
  md.renderer.rules.footnote_block_open = () => '<section class="footnotes"><ol class="refs">\n';
  md.renderer.rules.footnote_block_close = () => "</ol></section>\n";

  md.core.ruler.push("oc_structure", (state) => {
    const tokens = state.tokens;
    const used = new Set<string>();
    let n = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      // Numbered, linkable ## headings, collected for the contents list.
      if (t.type === "heading_open" && t.tag === "h2") {
        const inline = tokens[i + 1];
        const text = inline.content.trim();
        let id = slug(text);
        while (used.has(id)) id += "-x";
        used.add(id);
        t.attrSet("id", id);
        let label = text;
        if (!/^\d/.test(text) && !UNNUMBERED.test(text)) {
          n += 1;
          label = `${n} ${text}`;
          const num = new state.Token("text", "", 0);
          num.content = `${n} `;
          inline.children?.unshift(num);
        }
        toc.push({ id, text: label });
      }
      // > **Theorem 1.** ... => a theorem block.
      if (t.type === "blockquote_open" && tokens[i + 1]?.type === "paragraph_open") {
        // (markdown-it starts the paragraph with an empty text token; skip it)
        const kids = (tokens[i + 2]?.children ?? []).filter((k) => !(k.type === "text" && k.content === ""));
        if (kids[0]?.type === "strong_open" && THEOREM_RE.test(kids[1]?.content ?? "")) t.attrJoin("class", "thm");
      }
      // "ePrint 2024/123" => a link to our page for that paper.
      if (t.type === "inline" && t.children) t.children = linkEprint(t.children, state.Token);
    }
  });
  return md;
}

function linkEprint(children: Token[], TokenCtor: typeof Token): Token[] {
  const out: Token[] = [];
  let inLink = 0;
  for (const c of children) {
    if (c.type === "link_open") inLink++;
    if (c.type === "link_close") inLink--;
    if (c.type !== "text" || inLink || !EPRINT_RE.test(c.content)) {
      out.push(c);
      continue;
    }
    EPRINT_RE.lastIndex = 0;
    let last = 0;
    for (const m of c.content.matchAll(EPRINT_RE)) {
      const at = m.index ?? 0;
      if (at > last) out.push(textToken(TokenCtor, c.content.slice(last, at)));
      const open = new TokenCtor("link_open", "a", 1);
      open.attrSet("href", `/${m[1]}/${Number(m[2])}`);
      out.push(open, textToken(TokenCtor, m[0]), new TokenCtor("link_close", "a", -1));
      last = at + m[0].length;
    }
    if (last < c.content.length) out.push(textToken(TokenCtor, c.content.slice(last)));
  }
  return out;
}

function textToken(TokenCtor: typeof Token, s: string): Token {
  const t = new TokenCtor("text", "", 0);
  t.content = s;
  return t;
}

/** What a manuscript file says about itself: the first `# ` heading and the `## Abstract` section. */
export function extractMeta(src: string): { title: string; abstract: string } {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const title = lines.find((l) => /^#\s+\S/.test(l))?.replace(/^#\s+/, "").trim() ?? "";
  const a = lines.findIndex((l) => /^##\s+abstract\s*$/i.test(l));
  let abstract = "";
  if (a !== -1) {
    const rest: string[] = [];
    for (const l of lines.slice(a + 1)) {
      if (/^#{1,2}\s/.test(l)) break;
      rest.push(l);
    }
    abstract = rest.join("\n").trim();
  }
  return { title, abstract };
}

/** The body for the reading page: without the leading `# Title` and the `## Abstract` section. */
function bodyOnly(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let skipping = false;
  let titleDropped = false;
  for (const l of lines) {
    if (!titleDropped && /^#\s+\S/.test(l)) {
      titleDropped = true;
      continue;
    }
    if (/^##\s+abstract\s*$/i.test(l)) {
      skipping = true;
      continue;
    }
    if (skipping && /^#{1,2}\s/.test(l)) skipping = false;
    if (!skipping) out.push(l);
  }
  return out.join("\n");
}

export function renderManuscript(src: string): Rendered {
  const toc: Rendered["toc"] = [];
  const md = makeRenderer(toc);
  const html = md.render(bodyOnly(src));
  // Footnotes render after the body; give them a References heading and a contents entry if the
  // author didn't write one.
  if (html.includes('class="footnotes"') && !toc.some((t) => /^(\d+\s+)?references$/i.test(t.text))) {
    toc.push({ id: "references", text: "References" });
    return { html: html.replace('<section class="footnotes">', '<section class="footnotes"><h2 id="references">References</h2>'), toc };
  }
  return { html, toc };
}

/** A short field (title, abstract) with math and inline Markdown, no block structure. */
export function renderInline(src: string): string {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  md.inline.ruler.before("escape", "math_inline", mathInline);
  md.renderer.rules.math_inline = (tokens, i) => md.utils.escapeHtml(tokens[i].content);
  return md.renderInline(src);
}
