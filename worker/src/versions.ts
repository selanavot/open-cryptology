// Version history: every distinct PDF we hold for a paper (db `versions`), labelled by when the
// source captured it ("copy captured 2024-03-02"), not by ePrint revision numbers, which we don't
// know for copies from public mirrors. See docs/VERSIONS.md.

import type { Version } from "./db";
import { html, type Html } from "./html";

const SOURCE_SHORT: Record<string, string> = {
  "github-mirror": "GitHub mirror",
  wayback: "Wayback Machine",
  upload: "verified upload",
  other: "public copy",
};

export const STAMP_RE = /^\d{8}T\d{6}Z$/;

export const versionPath = (id: string, v: Pick<Version, "stamp">): string => `/${id}/versions/${v.stamp}.pdf`;

export function fmtSize(n: number | null): string {
  if (!n) return "";
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

const day = (iso: string) => iso.slice(0, 10);

/** Compact list for the paper page's metadata column, newest first. */
export function versionsList(id: string, versions: Version[], pdfKey: string | null): Html | "" {
  if (!versions.length) return "";
  return html`<dt id="versions">Versions</dt>
      <dd><ul class="versions">${versions.map(
        (v) => html`<li><a href="${versionPath(id, v)}" rel="nofollow">copy captured <time datetime="${v.captured_at}">${day(v.captured_at)}</time></a>
          <small class="text-muted">${[SOURCE_SHORT[v.source] ?? v.source, fmtSize(v.size)].filter(Boolean).join(" · ")}${v.r2_key === pdfKey ? " · default PDF" : ""}</small></li>`,
      )}</ul>
      ${versions.length > 1 && html`<div class="small text-muted">Dated by capture, not ePrint version numbers.</div>`}</dd>`;
}

export function versionJson(origin: string, id: string, v: Version, pdfKey: string | null) {
  return {
    url: `${origin}${versionPath(id, v)}`,
    captured_at: v.captured_at,
    label: `copy captured ${day(v.captured_at)}`,
    source: v.source,
    source_url: v.source_url,
    size: v.size,
    sha256: v.sha256,
    is_default_pdf: v.r2_key === pdfKey,
  };
}
