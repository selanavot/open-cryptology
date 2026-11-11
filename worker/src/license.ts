import type { Paper } from "./db";
import { parseAuthors } from "./db";

export const LICENSE_CODES = ["CC BY", "CC BY-SA", "CC BY-NC", "CC BY-NC-SA", "CC BY-NC-ND", "CC0"] as const;

const DEFAULT_DEEDS: Record<string, string> = {
  "CC BY": "https://creativecommons.org/licenses/by/4.0/",
  "CC BY-SA": "https://creativecommons.org/licenses/by-sa/4.0/",
  "CC BY-NC": "https://creativecommons.org/licenses/by-nc/4.0/",
  "CC BY-NC-SA": "https://creativecommons.org/licenses/by-nc-sa/4.0/",
  "CC BY-NC-ND": "https://creativecommons.org/licenses/by-nc-nd/4.0/",
  CC0: "https://creativecommons.org/publicdomain/zero/1.0/",
};

/** Same normalization as pipeline/harvest_oai.py:license_code, restricted to known codes. */
export function licenseCode(url: string | null | undefined): string | null {
  if (!url) return null;
  const u = url.trim().toLowerCase();
  if (u.includes("publicdomain/zero")) return "CC0";
  const m = /creativecommons\.org\/licenses\/([a-z-]+)\//.exec(u);
  if (!m) return null;
  const code = "CC " + m[1].toUpperCase();
  return (LICENSE_CODES as readonly string[]).includes(code) ? code : null;
}

export interface LicenseInfo {
  code: string | null;
  url: string | null;
  label: string; // e.g. "CC BY 4.0"
  attribution: string;
  retroactive: boolean;
  nc: boolean;
  nd: boolean;
  sa: boolean;
}

/** ePrint's list of every version of a paper (also the way to a withdrawn paper's earlier PDFs). */
export const versionsUrl = (base: string, id: string): string => `${base.replace(/\/$/, "")}/archive/versions/${id}/`;

export function originalUrl(originBase: string, id: string): string {
  return `${originBase.replace(/\/$/, "")}/${id}`;
}

export function licenseInfo(p: Paper, originBase: string): LicenseInfo {
  const code = p.license_code;
  const url = p.license_url || (code ? DEFAULT_DEEDS[code] ?? null : null);
  const ver = url ? /\/(\d+\.\d+)\/?$/.exec(url)?.[1] : undefined;
  const label = code ? (ver ? `${code} ${ver}` : code) : "License unknown";
  const authors = parseAuthors(p.authors);
  const who = authors.length ? authors.join(", ") : "the authors";
  const attribution =
    `“${p.title}” by ${who}, Cryptology ePrint Archive, Paper ${p.id}, ` +
    `${originalUrl(originBase, p.id)}` +
    (code ? `. Licensed under ${label}${url ? ` (${url})` : ""}.` : ".");
  return {
    code,
    url,
    label,
    attribution,
    retroactive: !!p.retro_license,
    nc: !!code && code.includes("NC"),
    nd: !!code && code.includes("ND"),
    sa: !!code && code.includes("SA"),
  };
}

export function bibtex(p: Paper, originBase: string): string {
  const authors = parseAuthors(p.authors).join(" and ");
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  return [
    `@misc{cryptoeprint:${p.id},`,
    `      author = {${clean(authors)}},`,
    `      title = {${clean(p.title)}},`,
    `      howpublished = {Cryptology {ePrint} Archive, Paper ${p.id}},`,
    `      year = {${p.year}},`,
    `      url = {${originalUrl(originBase, p.id)}}`,
    `}`,
  ].join("\n");
}
