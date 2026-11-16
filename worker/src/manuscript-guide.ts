// How to format an original manuscript: /manuscripts/format (for people; each convention shown as
// the Markdown you write next to how it typesets, rendered live by markdown.ts) and
// /manuscripts/template.md (a starting file). Agents get the same conventions in llms.txt.
import type { Env } from "./db";
import { html, raw, type Html } from "./html";
import { page } from "./layout";
import { renderInline, renderManuscript } from "./markdown";

export const TEMPLATE_MD = `# Your title, with math like $2^{61}$ if needed

## Abstract

One paragraph: what you show, and how. It fills in the abstract on the submit form.

## Introduction

Context and contributions. Cite earlier work with a footnote key[^example25], and mention
ePrint papers by id, like ePrint 2019/256, to link them.

## How this was made

Which models and tools you used, and what a person checked.

## Results

> **Theorem 1.** State the result here, with math inline ($x \\oplus y$) or on its own line:
> $$\\Pr[\\mathsf{E}] \\le 2^{-64}.$$

*Proof.* ... $\\square$

| Rounds | Time |
|---|---|
| 6 | $2^{70}$ |
| 7 | $2^{61}$ |

## Conclusion

What's open.

[^example25]: A. Author and B. Author. Title of the paper. *Venue 2025*.
`;

interface Example {
  id: string;
  title: string;
  note: Html;
  md: string;
  /** Override for examples the body renderer doesn't show (title and abstract). */
  shown?: Html;
}

const EXAMPLES: Example[] = [
  {
    id: "title",
    title: "Title and abstract",
    note: html`Start the file with <code># Title</code>, then an <code>## Abstract</code> section. Both fill in the submit form, and the
    page shows them above the text.`,
    md: `# Four-round preimages for SampleHash

## Abstract

We find preimages for 4 of the 12 rounds in time $2^{96}$.`,
    shown: html`<div class="rd-titleblock"><h1 class="tex">${raw(renderInline("Four-round preimages for SampleHash"))}</h1></div>
<div class="rd-abstract"><h2>Abstract</h2><p class="tex">${raw(renderInline("We find preimages for 4 of the 12 rounds in time $2^{96}$."))}</p></div>`,
  },
  {
    id: "sections",
    title: "Sections",
    note: html`<code>##</code> headings are numbered and make up the contents list; <code>###</code> are subsections. References,
    Acknowledgments and Appendix aren't numbered.`,
    md: `## Introduction

Some text.

### Our contributions

More text.`,
  },
  {
    id: "math",
    title: "Math",
    note: html`LaTeX between <code>$...$</code> inline, or <code>$$...$$</code> on its own line. Markdown doesn't touch what's inside,
    so <code>_</code> and <code>*</code> are safe.`,
    md: `The key has $k = 128$ bits and
$$\\Pr_x[E_K(x) \\oplus E_K(x \\oplus \\Delta) = \\nabla] \\approx 2^{-18}.$$`,
  },
  {
    id: "theorems",
    title: "Theorems, lemmas and definitions",
    note: html`A quote that starts with a bold label: Theorem, Lemma, Proposition, Corollary, Definition, Claim, Conjecture, Remark,
    Example or Assumption.`,
    md: `> **Theorem 1.** Seven rounds can be attacked in time $2^{61}$.

*Proof sketch.* Extend the distinguisher by one round on each side. $\\square$`,
  },
  {
    id: "references",
    title: "References",
    note: html`Footnotes with a key you choose: cite with <code>[^key]</code> and write the entry anywhere in the file. They're numbered
    in order of first citation and listed under References. “ePrint 2024/123” links to that paper.`,
    md: `The best attack reaches 6 rounds[^kolbl15],
building on ePrint 2019/256.

[^kolbl15]: S. Kölbl, G. Leander and T. Tiessen. Observations on the SIMON block cipher family. *CRYPTO 2015*.`,
  },
  {
    id: "tables",
    title: "Tables, lists and code",
    note: html`As in any Markdown: pipes for tables, <code>-</code> or <code>1.</code> for lists, three backticks for code.`,
    md: `| Rounds | Time |
|---|---|
| 6 | $2^{70}$ |
| 7 | $2^{61}$ |

- first point
- second point

\`\`\`
python3 attack.py --rounds 7
\`\`\``,
  },
];

function exampleHtml(e: Example): Html {
  const shown = e.shown ?? raw(renderManuscript(e.md).html);
  return html`<section class="fmt-ex" id="${e.id}">
  <h2>${e.title}</h2>
  <p class="fmt-note">${e.note}</p>
  <div class="fmt-pair">
    <div><p class="fmt-label">You write</p><pre class="fmt-src">${e.md}</pre></div>
    <div><p class="fmt-label">It looks like</p><div class="fmt-out rd-doc tex">${shown}</div></div>
  </div>
</section>`;
}

export function formatGuidePage(env: Env): Response {
  return page(env, {
    title: "How to format a manuscript",
    description: "Original manuscripts are Markdown files. What to write for sections, math, theorems and references.",
    katex: true,
    cache: "public, max-age=3600",
    body: html`<article class="fmt">
  <h1 class="ms-title">How to format a manuscript</h1>
  <p>An original manuscript is one Markdown file (<code>.md</code>): plain text you can write in any editor, or have a model write.
  It gets a typeset reading page like a paper.</p>
  <p class="fmt-actions"><a class="btn btn-outline-dark btn-sm" href="/manuscripts/template.md" download="manuscript.md">Download a template</a>
  <a class="btn btn-outline-dark btn-sm" href="/submit">Submit a manuscript</a></p>
  ${EXAMPLES.map(exampleHtml)}
  <section class="fmt-ex" id="other">
  <h2>Good to know</h2>
  <ul>
    <li>Raw HTML isn't allowed; anything in angle brackets shows as text.</li>
    <li>Say how the work was made: which models and tools, and what a person checked.</li>
    <li>Files are UTF-8, up to 200 KB.</li>
  </ul>
  </section>
</article>`,
  });
}

export function templateMd(): Response {
  return new Response(TEMPLATE_MD, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": 'inline; filename="manuscript.md"',
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
