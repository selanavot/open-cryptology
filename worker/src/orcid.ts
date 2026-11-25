// ORCID iDs and authors' emails as people type them: normalizing, checking, and the iD icon.
import { html, raw, type Html } from "./html";

const ORCID_ID = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

/** The ORCID iD in what someone typed ("0000-0002-1825-0097", "https://orcid.org/0000-...",
 *  "orcid.org/...", or the 16 characters without dashes), or null if there is none or its check
 *  digit is wrong (ISO 7064 11,2). app.js checks the same way as people type. */
export function parseOrcid(s: string): string | null {
  let t = s
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?orcid\.org\//i, "")
    .replace(/\/$/, "")
    .toUpperCase();
  if (/^\d{15}[\dX]$/.test(t)) t = t.replace(/(.{4})(?=.)/g, "$1-");
  if (!ORCID_ID.test(t)) return null;
  const digits = t.replace(/-/g, "");
  let total = 0;
  for (const ch of digits.slice(0, -1)) total = (total + Number(ch)) * 2;
  const check = (12 - (total % 11)) % 11;
  return digits.at(-1) === (check === 10 ? "X" : String(check)) ? t : null;
}

/** A plausible email address, lowercased, or null. */
export function parseEmail(s: string): string | null {
  const t = s.trim().toLowerCase();
  return t.length <= 254 && /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(t) ? t : null;
}

/** ORCID's iD icon, linking to the author's ORCID record. */
export const orcidLink = (id: string): Html =>
  html`<a class="orcid-link" href="https://orcid.org/${id}" title="ORCID ${id}" aria-label="ORCID iD ${id}" rel="noopener">${ORCID_ICON}</a>`;

const ORCID_ICON = raw(
  `<svg class="orcid-icon" viewBox="0 0 256 256" width="14" height="14" aria-hidden="true" focusable="false"><circle cx="128" cy="128" r="128" fill="#A6CE39"/><g fill="#fff"><rect x="70" y="79" width="17" height="99"/><circle cx="78.5" cy="62" r="11"/><path d="M107 79h45c43 0 62 31 62 50 0 21-17 50-62 50h-45zm17 85h27c38 0 47-29 47-35 0-21-14-35-46-35h-28z"/></g></svg>`,
);
