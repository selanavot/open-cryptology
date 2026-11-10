// Tiny HTML templating: `html` tagged templates escape every interpolation unless it is an
// `Html` value (produced by `html` itself or by `raw`). Arrays are concatenated; null,
// undefined, false and true render as nothing (so `cond && html`...`` works).

export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export type Val = Html | string | number | boolean | null | undefined | Val[];

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

function render(v: Val): string {
  if (v === null || v === undefined || v === false || v === true) return "";
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...vals: Val[]): Html {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += render(vals[i]) + strings[i + 1];
  return new Html(out);
}

/** Trusted, pre-built markup. Never pass user/DB data here unescaped. */
export const raw = (s: string): Html => new Html(s);

/** Only allow http(s) URLs into href attributes (sources table, license URLs come from data). */
export function safeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? p.toString() : null;
  } catch {
    return null;
  }
}

/** Escape text, then turn private-use highlight markers (from FTS5 highlight/snippet) into <mark>. */
export const HL_OPEN = "";
export const HL_CLOSE = "";
export function highlighted(s: string): Html {
  const e = esc(s).split(HL_OPEN).join("<mark>").split(HL_CLOSE).join("</mark>");
  return raw(e);
}
export const stripMarks = (s: string): string => s.split(HL_OPEN).join("").split(HL_CLOSE).join("");
