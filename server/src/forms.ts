// Curated catalogue of official forms / action pages a stop can link to.
//
// SECURITY: the AI never writes a form URL. It may only pick a form by `id`
// from this list; the server maps the id to the URL. Unknown ids are dropped,
// and every URL must also pass the allow-list check.
//
// Non-EU forms stay here so the same mechanism can serve other scenarios later.

import { isAllowedUrl, safeFetchRaw } from "./allowlist.js";
import type { Audience, Topic } from "./sources.js";

export type FormLink = {
  id: string;
  /** Text on the button. */
  label: string;
  url: string;
  topic: Topic;
  appliesTo: Audience;
  /** Who/where it is valid for — shown to the AI so it can pick precisely. */
  scope: string;
  /** When to use it — shown to the AI. */
  description: string;
  lang: "en" | "de" | "fr" | "it";
  kind: "web-form" | "pdf-form" | "info-page";
};

export const FORMS: FormLink[] = [
  // --- Housing ---------------------------------------------------------------
  {
    id: "bfh-housing",
    label: "Find accommodation",
    url: "https://www.bfh.ch/en/studies/studies-life/wohnen/",
    topic: "housing",
    appliesTo: "all",
    scope: "BFH students looking for a room in or around Bern",
    description:
      "BFH's accommodation page with the student housing platforms it partners with. Use for the step of finding a place to live.",
    lang: "en",
    kind: "info-page",
  },

  // --- Registration / residence permit ---------------------------------------
  {
    id: "bern-exchange-registration",
    label: "Register with the City of Bern (exchange students)",
    url: "https://www.bern.ch/themen/zuzug-umzug-wegzug/webformular-semp-isep-austausch-studierende-EU-EFTA",
    topic: "registration",
    appliesTo: "eu",
    scope: "EU/EFTA exchange students (SEMP, ISEP or other exchange) who LIVE IN THE CITY OF BERN",
    description:
      "Online registration form of the City of Bern for EU/EFTA exchange students arriving from abroad; registers the address and starts the residence permit.",
    lang: "de",
    kind: "web-form",
  },
  {
    id: "bern-eu-student-registration",
    label: "Register with the City of Bern (EU/EFTA students)",
    url: "https://www.bern.ch/themen/zuzug-umzug-wegzug/webformular-zuzug-ausland-eu-efta-studierende",
    topic: "registration",
    appliesTo: "eu",
    scope: "EU/EFTA degree students (not exchange) who LIVE IN THE CITY OF BERN",
    description:
      "Online registration form of the City of Bern for EU/EFTA students enrolled in a full degree, arriving from abroad.",
    lang: "de",
    kind: "web-form",
  },
  {
    id: "bern-thirdcountry-registration",
    label: "Registration form for non-EU/EFTA nationals (City of Bern)",
    url: "https://www.bern.ch/themen/auslanderinnen-und-auslander/einreise-und-aufenthalt/aufenthalt-zur-aus-und-weiterbildung/downloads/anmeldung-zuzug-ausland-drittstaat-form-abg.pdf",
    topic: "registration",
    appliesTo: "non-eu",
    scope: "Non-EU/EFTA nationals arriving from abroad who live in the City of Bern",
    description: "PDF registration form for third-country nationals arriving from abroad.",
    lang: "de",
    kind: "pdf-form",
  },

  // --- Health insurance -------------------------------------------------------
  {
    id: "asv-form-a",
    label: "Health insurance exemption — Form A",
    url: "https://www.asv.dij.be.ch/content/dam/asv_dij/dokumente/de/kvg-obligatorium/Formular%20A-Aus-+Weiterbildung_de.pdf",
    topic: "insurance",
    appliesTo: "all",
    scope: "Students and trainees living in the CANTON OF BERN (any municipality)",
    description:
      "Canton of Bern application to be exempted from Swiss compulsory health insurance for people in education who are insured in their home country.",
    lang: "de",
    kind: "pdf-form",
  },

  // --- Entry (non-EU/EFTA) -------------------------------------------------------
  {
    id: "eda-representations",
    label: "Find your Swiss embassy or consulate",
    url: "https://www.eda.admin.ch/de/schweizer-vertretungen-im-ausland",
    topic: "visa",
    appliesTo: "non-eu",
    scope: "Non-EU/EFTA nationals applying for a visa or permit before travelling",
    description:
      "Directory of Swiss representations abroad; the visa and permit application is made in person at the one responsible for the student's place of residence.",
    lang: "de",
    kind: "info-page",
  },

  // --- Leaving Switzerland -------------------------------------------------------
  {
    id: "bern-departure-abroad",
    label: "Deregister: moving abroad (City of Bern)",
    url: "https://www.bern.ch/themen/zuzug-umzug-wegzug/formular-wegzug-ausland",
    topic: "departure",
    appliesTo: "all",
    scope: "People who LIVE IN THE CITY OF BERN and move abroad",
    description:
      "Online form of the City of Bern for deregistering when leaving Switzerland; the residence permit card is returned with it.",
    lang: "de",
    kind: "web-form",
  },

  // --- Work ---------------------------------------------------------------------
  {
    id: "bern-work-permits",
    label: "Check the rules for working",
    url: "https://www.bern.ch/themen/auslanderinnen-und-auslander/einreise-und-aufenthalt/arbeiten-in-bern/arbeitsbewilligungen",
    topic: "work",
    appliesTo: "all",
    scope: "Foreign nationals who want to work while living in the City of Bern",
    description: "City of Bern page on work permits and what to do before taking up a job.",
    lang: "de",
    kind: "info-page",
  },
  {
    id: "awi-job-start",
    label: "Employer's application to start a job (non-EU)",
    url: "https://www.weu.be.ch/content/dam/weu/dokumente/awi-ava/de/wirtschaft-arbeit/unternehmen/formulare/formular-ab-stellenantritt-de.pdf",
    topic: "work",
    appliesTo: "non-eu",
    scope: "Employers in the canton of Bern hiring a non-EU/EFTA national, incl. students' part-time jobs",
    description:
      "Canton of Bern form the employer submits to the Office for Economic Affairs before a non-EU/EFTA person starts work.",
    lang: "de",
    kind: "pdf-form",
  },
];

// Forms that failed the last reachability check are hidden from the AI.
const brokenForms = new Set<string>();

/** Check every form link still loads (through the allow-list). */
export async function verifyForms() {
  const results: { id: string; ok: boolean; reason?: string }[] = [];
  for (const form of FORMS) {
    try {
      await safeFetchRaw(form.url);
      brokenForms.delete(form.id);
      results.push({ id: form.id, ok: true });
    } catch (err) {
      brokenForms.add(form.id);
      results.push({ id: form.id, ok: false, reason: (err as Error).message });
    }
  }
  return results;
}

function usable(form: FormLink): boolean {
  return isAllowedUrl(form.url) && !brokenForms.has(form.id);
}

/** Forms the AI may choose from for this audience. */
export function formsFor(audience: "eu" | "non-eu" | null): FormLink[] {
  return FORMS.filter(
    (f) => usable(f) && (audience === null || f.appliesTo === "all" || f.appliesTo === audience),
  );
}

export function formById(id: string): FormLink | undefined {
  return FORMS.find((f) => f.id === id && usable(f));
}
