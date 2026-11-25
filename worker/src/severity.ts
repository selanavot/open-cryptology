// Severity of an Issue post (comments.ts) and /severity, the page that explains the levels.
//
// This is a first version (November 2026), to be revised with cryptographers. The levels and their
// text all live here: the composer's picker, the chip on a posted Issue, the API's error message and
// llms.txt take them from SEVERITY. Levels are stored by key in comments.severity with no CHECK in
// the database, so renaming or adding one is a code change; removing one means mapping old rows.
import type { Env } from "./db";
import { html, type Html } from "./html";
import { page } from "./layout";

export interface Level {
  key: string;
  label: string;
  /** The definition: on /severity, as the picker's and the chip's tooltip, and in llms.txt. */
  short: string;
  /** Shown on /severity after "For example:". */
  examples: string[];
}

/** Most severe first. */
export const SEVERITY = [
  {
    key: "critical",
    label: "Critical",
    short: "The main contribution does not stand, and no repair is known.",
    examples: [
      "an attack on the scheme as specified that the security theorem rules out;",
      "a counterexample to the main theorem;",
      "a central proof step that can’t be fixed without changing the construction or the assumptions.",
    ],
  },
  {
    key: "high",
    label: "High",
    short: "A main result fails as stated, and survives only weakened or significantly changed.",
    examples: [
      "a bound wrong enough that the parameters must be redone in a meaningful way;",
      "a proof that covers less than the claim;",
      "a theorem that holds only after the construction is changed.",
    ],
  },
  {
    key: "medium",
    label: "Medium",
    short: "A result fails as written but is easily repaired, or a side result fails.",
    examples: [
      "a missing hypothesis that holds in every intended use;",
      "a bound off by a constant factor that changes no conclusion and no parameter;",
      "a side theorem or application that doesn’t hold.",
    ],
  },
  {
    key: "low",
    label: "Low",
    short: "Every result holds, but a proof or the specification is wrong.",
    examples: [
      "a simulator that misses a corner case and can be patched;",
      "a false supporting lemma whose use can be avoided;",
      "an algorithm that is wrong as printed, when the intended version is clear.",
    ],
  },
] as const satisfies readonly Level[];

export type Severity = (typeof SEVERITY)[number]["key"];
export const SEVERITY_KEYS: readonly string[] = SEVERITY.map((l) => l.key);
export const severityLevel = (key: string | null | undefined): Level | undefined => SEVERITY.find((l) => l.key === key);

/** "critical", "high", "medium" or "low" (for messages and llms.txt). */
export const severityList = (): string => {
  const q = SEVERITY.map((l) => `"${l.key}"`);
  return `${q.slice(0, -1).join(", ")} or ${q[q.length - 1]}`;
};

/** /severity: what the levels mean. Linked from the composer's picker and from each Issue's chip. */
export function severityPage(env: Env): Response {
  return page(env, {
    title: "Severity of issues",
    description: `How ${env.SITE_NAME} rates the issues readers raise on papers: Critical, High, Medium and Low. Far from final; tell us what you think.`,
    canonical: "https://opencryptology.org/severity",
    cache: "public, max-age=3600",
    body: severityBody(),
  });
}

export function severityBody(): Html {
  return html`<section class="message severity-page">
  <h3>Severity of issues</h3>
  <p class="severity-draft">This is a new project, that is just now getting off the ground (November 2026).
  Therefore, the severity definitions (and everything else) are far from finalized.
  Do <a href="/contact">tell us</a> what you think.</p>

  <p>An Issue’s severity is determined by how it affects the paper’s contribution. In particular, it
  rates the paper as written, rather than exploitability and downstream impact.</p>

  ${SEVERITY.map(
    (l) => html`<div class="severity-level" id="${l.key}">
    <h4><span class="cm-flair cm-flair-issue cm-sev-${l.key}">${l.label}</span></h4>
    <p>${l.short} For example:</p>
    <ul>${l.examples.map((e) => html`<li>${e}</li>`)}</ul>
  </div>`,
  )}
</section>`;
}
