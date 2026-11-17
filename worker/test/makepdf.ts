// Small, valid PDFs built in code for the tests (the repo holds no PDF files).

export interface PdfOptions {
  /** Lines of text per page, top to bottom (Helvetica, so pdf.js needs no font files). */
  pages?: string[][];
  /** Extra entries for the document catalog, e.g. "/OpenAction 9 0 R". */
  catalogExtra?: string;
  /** Extra objects, numbered after the built-in ones; refer to them as (base + i). */
  extraObjects?: (base: number) => string[];
}

/** Escape a string for a PDF literal string. */
const lit = (s: string) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;

/** A complete PDF with a correct cross-reference table, as bytes. */
export function makePdf(opts: PdfOptions = {}): ArrayBuffer {
  const pages = opts.pages ?? [["Hello"]];
  // 1 catalog, 2 page tree, 3 font, then a page object and a content stream for each page.
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${4 + 2 * i} 0 R`).join(" ");
  const base = 4 + 2 * pages.length;
  objs.push(`<< /Type /Catalog /Pages 2 0 R ${opts.catalogExtra ?? ""} >>`);
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objs.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
  pages.forEach((lines, i) => {
    const content = lines.map((l, j) => `BT /F1 14 Tf 72 ${740 - 20 * j} Td ${lit(l)} Tj ET`).join("\n");
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`,
    );
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  objs.push(...(opts.extraObjects?.(base) ?? []));

  let out = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return latin1Bytes(out);
}

export function latin1Bytes(s: string): ArrayBuffer {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b.buffer;
}
