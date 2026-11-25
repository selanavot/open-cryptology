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
  /** One line: the picker's and the chip's tooltip. */
  short: string;
  /** The definition on /severity. */
  long: string;
  examples: string[];
}

/** Most severe first. */
export const SEVERITY = [
  {
    key: "critical",
    label: "Critical",
    short: "The main contribution does not stand, and no repair is known.",
    long: "The paper’s main contribution does not stand: a main theorem or headline claim is false or unproved, and no known repair keeps it.",
    examples: [
      "An attack on the scheme as specified that its security theorem says is impossible.",
      "A counterexample to the main theorem.",
      "A central step of the main proof that can’t be fixed without changing the construction or the assumptions.",
    ],
  },
  {
    key: "high",
    label: "High",
    short: "A main result fails as stated; it survives only after a real change or in a weaker form.",
    long: "A main result is false or unproved as stated, and repairing it costs something real: the contribution survives only in a weaker form, under a stronger assumption, with a changed construction or with new parameters.",
    examples: [
      "A security bound that is off by enough that the proposed parameters miss their target until they are redone (for instance, a lemma reused from earlier work with a missing square root).",
      "A claimed property, such as malicious or UC security, that is asserted but not proved.",
      "A theorem that holds only after the construction is changed.",
    ],
  },
  {
    key: "medium",
    label: "Medium",
    short: "A stated result fails as written, but a routine repair restores it; or a secondary result fails.",
    long: "A stated result is false or unproved as written, but a routine repair restores it and the contribution is intact; or a secondary result fails.",
    examples: [
      "A theorem missing a hypothesis that holds in every intended use.",
      "A bound off by a constant factor that changes no conclusion and no parameter.",
      "A side theorem, extension or application that doesn’t hold.",
    ],
  },
  {
    key: "low",
    label: "Low",
    short: "Every stated result holds, but a proof, lemma or specification is wrong or incomplete.",
    long: "Every stated result holds, but a proof, a supporting lemma or the specification is wrong or incomplete.",
    examples: [
      "A simulator that fails in one corner case and can be patched.",
      "A false supporting lemma whose use can be avoided.",
      "An algorithm that is wrong as printed, when the intended version is clear and correct.",
      "A proof that skips a step that is not routine.",
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
    description: `How ${env.SITE_NAME} rates the issues readers raise on papers: Critical, High, Medium and Low. An early version; we want other opinions.`,
    canonical: "https://opencryptology.org/severity",
    cache: "public, max-age=3600",
    body: severityBody(),
  });
}

export function severityBody(): Html {
  return html`<section class="message severity-page">
  <h3>Severity of issues</h3>
  <p class="severity-draft"><strong>This is an early version.</strong> We wrote it in November 2026 and
  will revise it with cryptographers, so the levels and their wording may change. We want other opinions:
  <a href="/contact">tell us what you would change</a>.</p>

  <p>A post labelled Issue says something in a paper is wrong or unproved, and carries a severity: how much
  of the paper’s contribution the issue affects, if it is right. Severity is not about how exploitable a
  flaw is, and it rates the paper as written, not its authors. It is the poster’s assessment: others can
  disagree in replies, and the poster can change it.</p>

  ${SEVERITY.map(
    (l) => html`<div class="severity-level" id="${l.key}">
    <h4><span class="cm-flair cm-flair-issue cm-sev-${l.key}">${l.label}</span></h4>
    <p>${l.long}</p>
    <ul>${l.examples.map((e) => html`<li>${e}</li>`)}</ul>
  </div>`,
  )}

  <h4>Not issues</h4>
  <p>Typos, notation, wrong references and unclear writing aren’t issues. Post them as a comment, or leave them out.</p>

  <h4>Choosing a level</h4>
  <ul>
    <li>Judge by what happens to the paper’s claims, not by what kind of mistake it is: a one-character slip
    that breaks a security bound is High.</li>
    <li>If you’re torn between two levels, choose the lower one and say why in the text.</li>
    <li>If the error comes from a cited result, rate its effect on this paper and say where it comes from.</li>
    <li>If the issue affects implementations or deployed systems, say so in the text; the level doesn’t
    capture that.</li>
  </ul>
  <p class="text-muted small">Version of 25 November 2026.</p>
</section>`;
}
