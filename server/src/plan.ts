// Builds a student's plan.
//
// The work is split so that the model does as little as possible, and nothing
// that code can do exactly:
//
//   1. RULES  (plan-rules.ts)  decide which steps there are, their order, form,
//                              the reason each is in this plan, the effort.
//   2. TOOLS  (tools.ts)       fetch each step's evidence and key facts, and
//                              turn "14 days after arrival" into a date.
//   3. MODEL                   writes, for ONE step at a time: what to do and
//                              the conditions (why), a deadline if the evidence
//                              has one, and the documents the evidence names.
//   4. CHECKS (grounding.ts, facts.ts)  drop any number, deadline or document
//                              the evidence doesn't back, and add a key fact
//                              the model left out.
//
// One call per step (instead of one for the whole plan) is what makes it fast:
//   - a step's text depends only on the step, its evidence and the one or two
//     answers that shape it, so it is cached per STEP and shared by every
//     student in that situation, whatever the rest of their plan looks like;
//   - the steps every profile can produce are written ahead of time, in the
//     background (prewarmPlans), so most students wait for nothing at all;
//   - the app gets the skeleton at once and each step as it is finished.
// It also makes the text better: a small model given one step and three
// passages mixes up far less than one given seven steps and twenty.

import { createHash } from "node:crypto";
import { db } from "./db.js";
import { chat, LLM_MODEL, llmAvailable, stripThinking } from "./llm.js";
import {
  audienceFor,
  chunkKey,
  institutionFor,
  kbStatus,
  retrievePerQuery,
  RetrievedChunk,
} from "./knowledge.js";
import { formById, formsFor } from "./forms.js";
import { classifyCitizenship } from "./citizenship.js";
import { formatDate, planSteps, PlanStep } from "./plan-rules.js";
import { numbersSupported, quantities } from "./grounding.js";
import { ensureFacts, Fact, loadFacts, normalize } from "./facts.js";
import { addToDate, TimeUnit } from "./tools.js";

type Profile = Record<string, unknown>;
type Audience = "eu" | "non-eu";

// --- Prompt helpers (shared with the chat in index.ts) -----------------------

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export const isWebUrl = (url: string) => url.startsWith("https://");

// Summarise a profile for prompts. This text is only ever sent to the LOCAL
// model, never over the network.
export function summarizeProfile(profile: Profile): string {
  // State the citizenship group as a verified fact. Small models sometimes
  // "remember" EU membership wrongly (e.g. Croatia), so we never leave it to them.
  const nationality = typeof profile.nationality === "string" ? profile.nationality : "";
  const citizenship = nationality.trim() ? classifyCitizenship(nationality) : null;
  const citizenshipLine =
    citizenship &&
    (citizenship.group === "EU / EFTA"
      ? `Citizenship: ${citizenship.country ?? nationality} — VERIFIED: this student IS an EU/EFTA citizen. Treat this as fact.`
      : `Citizenship: ${nationality} — VERIFIED: this student is NOT an EU/EFTA citizen. Treat this as fact.`);
  return [
    profile.firstName && `Name: ${profile.firstName}`,
    citizenshipLine,
    profile.age && `Age: ${profile.age}`,
    profile.university && `Host university: ${profile.university}`,
    profile.degree && `Programme: ${profile.degree}`,
    profile.stayLength && `Length of stay: ${profile.stayLength}`,
    profile.canton && `Canton: ${profile.canton}`,
    profile.municipality && `Will live in: ${profile.municipality}`,
    profile.arrival && `Planned arrival: ${profile.arrival}`,
    profile.housingStatus && `Accommodation: ${profile.housingStatus}`,
    profile.plansToWork && `Plans to work in Switzerland: ${profile.plansToWork}`,
    profile.healthCoverage && `Health coverage from home: ${profile.healthCoverage}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// Numbered CONTEXT block the model must ground its answer in. Each item says
// whether it is an official source, practical coordinator guidance, or a
// document the student uploaded.
export function buildContext(chunks: RetrievedChunk[], firstNumber = 1): string {
  return chunks
    .map((c, i) => {
      const kind =
        c.authority === "coordinator"
          ? "COORDINATOR GUIDANCE"
          : c.authority === "student"
            ? "STUDENT'S OWN DOCUMENT"
            : "OFFICIAL SOURCE";
      const where = isWebUrl(c.url)
        ? c.url
        : c.authority === "student"
          ? "uploaded by the student, no link"
          : "internal notes, no link";
      return `[${i + firstNumber}] (${kind}) ${c.title} — ${where}\n${c.text}`;
    })
    .join("\n\n");
}

// Sources behind an answer (for the UI), one entry per page. `refs` holds every
// context number that came from that page, so "[4]" in the answer can always be
// found in the list. Local notes have no link, so they come back with an empty url.
export function sourceList(chunks: RetrievedChunk[]) {
  const byUrl = new Map<string, { n: number; refs: number[]; title: string; url: string }>();
  chunks.forEach((c, i) => {
    const existing = byUrl.get(c.url);
    if (existing) existing.refs.push(i + 1);
    else byUrl.set(c.url, { n: i + 1, refs: [i + 1], title: c.title, url: isWebUrl(c.url) ? c.url : "" });
  });
  return [...byUrl.values()];
}

// A key fact's quote as a context item, so it is numbered and cited like a source.
export const factChunk = (fact: Fact): RetrievedChunk => ({
  text: fact.quote,
  title: fact.title,
  url: fact.url,
  topic: fact.topic,
  authority: "official",
  score: 1,
});

// --- What the model writes for one step ----------------------------------------

const STEP_SCHEMA = {
  type: "object",
  properties: {
    why: { type: "string" },
    deadline: { type: "string" },
    documents: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        properties: { name: { type: "string" }, quote: { type: "string" } },
        required: ["name", "quote"],
      },
    },
    sourceNumber: { type: "integer" },
  },
  required: ["why", "deadline", "documents", "sourceNumber"],
};

// The same for every step and every student, so the model keeps it in memory
// between calls and only reads the short step-specific part each time.
const STEP_SYSTEM = [
  "You are HelvetiStart, an experienced coordinator for international students moving to Bern, Switzerland.",
  "You write the text for ONE step of a student's relocation plan. That the step is in the plan, its title and its form are already decided; you explain it.",
  "",
  "How to write:",
  "- Use only the numbered EVIDENCE. OFFICIAL SOURCE items decide rules, deadlines and documents; COORDINATOR GUIDANCE items add practical tips. If they disagree, the official source wins.",
  '- Cover everything in the "Must cover" note. It reflects this student\'s answers and is correct; never contradict it.',
  "- Evidence often also describes rules for other people (another citizenship group, people who move for a job, cross-border commuters, family members, renewals). Use only what applies to this student and this step.",
  '- Plain English, even when the evidence is in German. Address the student as "you".',
  "- Every number (hours, days, months, fees) must appear in the EVIDENCE — never from your own knowledge, since rules change. If the EVIDENCE doesn't give it, tell the student to check the source instead of guessing.",
  "- Never invent URLs, office names, fees, deadlines, requirements or documents.",
  "- Stay on this step. If the EVIDENCE says little about it, write little; never fill the space with another subject from the EVIDENCE (fees, permits, insurance).",
  "",
  "Fields:",
  '- why: two or three short sentences, at most 60 words in all: what to do, and the rules, limits and conditions the "Must cover" note asks for, taken from the EVIDENCE. Include each key fact with its exact figure. No introductions and no repetition; every word costs the student waiting time.',
  '- deadline: at most 8 words, and only a deadline the EVIDENCE states for this student\'s situation (a first application; not renewals, extensions or other permit types). If the EVIDENCE gives none, the empty string "" — never a sentence saying there is none.',
  "- documents: up to 4 papers the student must bring, send or show for this step, and that the EVIDENCE names (e.g. passport, rental contract, proof of insurance, a named form). Not web pages, offices or general information. For each: `name` (2 to 5 words, in English) and `quote` (the 2 to 8 words of the EVIDENCE that name it, copied exactly as written there, even if German). If the EVIDENCE names none, an empty list.",
  "- sourceNumber: the number of the EVIDENCE item that best supports your text.",
].join("\n");

type StepText = {
  why?: unknown;
  deadline?: unknown;
  documents?: unknown;
  sourceNumber?: unknown;
};

const STEP_OPTIONS = {
  // Temperature 0 keeps the same step from getting different text each run.
  temperature: 0,
  format: STEP_SCHEMA,
  // The model only writes text, so its slow reasoning pass is off by default
  // (PLAN_THINK=true turns it back on, to compare with `npm run bench`).
  think: process.env.PLAN_THINK === "true",
  // A step is about 130 tokens; the cap only stops a reply that runs away.
  maxTokens: 320,
};

// Profile answers a step may show the model, by the label used in prompts.
const ANSWER_LABELS: Record<string, string> = {
  stayLength: "Length of stay",
  municipality: "Will live in",
  degree: "Programme",
  housingStatus: "Accommodation",
  plansToWork: "Plans to work in Switzerland",
  healthCoverage: "Health coverage from home",
};

function stepPrompt(
  step: PlanStep,
  evidence: RetrievedChunk[],
  facts: Fact[],
  profile: Profile,
  audience: Audience,
): string {
  const answers = (step.uses ?? [])
    .map((key) => str(profile[key]) && `${ANSWER_LABELS[key] ?? key}: ${str(profile[key])}`)
    .filter(Boolean);
  return [
    `EVIDENCE:\n${buildContext(evidence)}`,
    `---\nSTEP: ${step.title} (${step.phase})`,
    `Must cover: ${step.brief}`,
    facts.length
      ? `Key facts (checked against the official sources; include each, with its exact figure): ${facts.map((f) => f.value).join(" ")}`
      : "",
    // Only what this step depends on: the citizenship GROUP (decided by
    // HelvetiStart, never by the model) and the answers the step declares.
    `STUDENT: ${audience === "eu" ? "an EU/EFTA citizen" : "NOT an EU/EFTA citizen"} (verified), studying in Switzerland with a residence permit for education.${answers.length ? `\n${answers.join("\n")}` : ""}`,
    "Write the text for this step now.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// --- Step cache -------------------------------------------------------------------
// The key hashes everything the model is given for the step, plus the model
// and its settings. A re-ingested source, an approved fact or an edited prompt
// gives a new key, so nothing goes stale.
const STEP_CACHE_DAYS = 30;

const stepKey = (user: string) =>
  createHash("sha256")
    .update(JSON.stringify({ model: LLM_MODEL, options: STEP_OPTIONS, system: STEP_SYSTEM, user }))
    .digest("hex");

function readCachedStep(key: string): StepText | undefined {
  const row = db
    .prepare(
      `SELECT text FROM plan_step_cache
        WHERE key = ? AND created_at > datetime('now', '-${STEP_CACHE_DAYS} days')`,
    )
    .get(key) as { text: string } | undefined;
  return row ? (JSON.parse(row.text) as StepText) : undefined;
}

function writeCachedStep(key: string, stepId: string, text: StepText) {
  db.prepare(
    "INSERT OR REPLACE INTO plan_step_cache (key, step_id, text, created_at) VALUES (?, ?, ?, datetime('now'))",
  ).run(key, stepId, JSON.stringify(text));
}

async function writeStep(user: string): Promise<StepText> {
  const reply = await chat(
    [
      { role: "system", content: STEP_SYSTEM },
      { role: "user", content: user },
    ],
    STEP_OPTIONS,
  );
  return JSON.parse(stripThinking(reply)) as StepText;
}

// --- Checks on what the model wrote ---------------------------------------------

// When a deadline can't be backed by the evidence, the step's phase gives a
// safe, general timing instead.
const PHASE_TIMING: Record<string, string> = {
  "Before you arrive": "Before arrival",
  "Before you start a job": "Before you start work",
  "Settling in": "When you need it",
  "Each year": "Before your permit runs out",
  "Before you leave": "Before you leave Switzerland",
};

const DEADLINE_FROM = { arrival: "of arrival", "job-start": "of starting your job" };

/** "Within 14 days of arrival", plus the date when the arrival date is known. */
function deadlineText(
  n: number,
  unit: string,
  from: "arrival" | "job-start",
  arrival: string,
): string {
  const period = `Within ${n} ${unit}${n === 1 ? "" : "s"} ${DEADLINE_FROM[from]}`;
  // The date is calculated by the calculate_deadline tool's function, never by the model.
  const due =
    from === "arrival" && unit !== "hour" ? formatDate(addToDate(arrival, n, unit as TimeUnit)) : "";
  return due ? `${period} (by ${due})` : period;
}

function resolveDeadline(
  step: PlanStep,
  written: string,
  evidenceText: string,
  facts: Fact[],
  arrival: string,
): string {
  // 1. An approved key fact states this step's deadline: the code writes it.
  for (const id of step.deadlineFacts ?? []) {
    const qs = quantities(facts.find((f) => f.id === id)?.value ?? "");
    if (qs.length === 1 && step.deadlineFrom) {
      return deadlineText(qs[0].n, qs[0].unit, step.deadlineFrom, arrival);
    }
  }
  // 2. The model's deadline, if every figure in it is in the evidence — in
  // digits or in words ("two weeks" needs a "2 weeks" or "zwei Wochen" there).
  const generic =
    /^(soon )?after (your )?arrival\.?$/i.test(written) ||
    // "No deadline is mentioned in the evidence" is not a deadline.
    /\b(no|not|none|n\/a|unspecified|unknown)\b/i.test(written);
  const qs = quantities(written);
  const inEvidence = new Set(quantities(evidenceText).map((q) => `${q.n} ${q.unit}`));
  const backed = qs.every((q) => inEvidence.has(`${q.n} ${q.unit}`));
  if (written && !generic && backed && numbersSupported(written, evidenceText)) {
    // "Within 14 days of arrival" can be given a date; "3 months after starting work" cannot.
    if (qs.length === 1 && step.deadlineFrom === "arrival" && !/work|job|employ/i.test(written)) {
      return deadlineText(qs[0].n, qs[0].unit, "arrival", arrival);
    }
    return written.replace(/\.$/, "");
  }
  // 3. Nothing the evidence backs: a general timing from the step's phase.
  return PHASE_TIMING[step.phase] ?? "Soon after arrival";
}

/**
 * A document stays only if the model's quote for it is really in the evidence.
 * This is what stops "proof of insurance" turning up on a bank-account step.
 * (Matching the words of the NAME against the evidence was tried as a second
 * way in, and let through things like "radio/TV fee confirmation".)
 */
function supportedDocuments(raw: unknown, evidenceText: string): string[] {
  if (!Array.isArray(raw)) return [];
  const evidence = normalize(evidenceText);
  const kept: string[] = [];
  for (const item of raw as { name?: unknown; quote?: unknown }[]) {
    const name = str(item?.name);
    const quote = normalize(str(item?.quote));
    if (!name || quote.length < 4 || !evidence.includes(quote)) continue;
    if (!kept.some((k) => k.toLowerCase() === name.toLowerCase())) {
      kept.push(name.charAt(0).toUpperCase() + name.slice(1));
    }
  }
  return kept;
}

export type PlanStop = {
  stepId: string;
  phase: string;
  title: string;
  why: string;
  personalisedBecause: string;
  deadline: string;
  time: string;
  documents: string[];
  sourceUrl: string;
  sourceTitle: string;
  formId: string;
  formUrl: string;
  formLabel: string;
  formLang: string;
  formKind: string;
  /** True while the model is still writing this step (the text is the short default). */
  pending?: boolean;
};

/** A step as the student sees it: the rules' decisions plus the checked text. */
function resolveStop(
  step: PlanStep,
  written: StepText,
  evidence: RetrievedChunk[],
  facts: Fact[],
  allFacts: Fact[],
  allowedFormIds: Set<string>,
  profile: Profile,
): PlanStop {
  const evidenceText = evidence.map((c) => c.text).join(" ");
  // The answers the step was shown may be repeated ("your 4–6 month stay").
  const shown = (step.uses ?? []).map((key) => str(profile[key])).join(" ");
  const why = str(written.why);
  const n = Number(written.sourceNumber);
  // Prefer the passage the model points at; otherwise the step's best search hit.
  const firstHit = evidence[facts.length] ?? evidence[0];
  const chunk: RetrievedChunk | undefined =
    Number.isInteger(n) && n >= 1 && n <= evidence.length ? evidence[n - 1] : firstHit;
  const form = step.formId && allowedFormIds.has(step.formId) ? formById(step.formId) : undefined;
  const grounded = why && numbersSupported(why, `${evidenceText} ${shown}`) ? why : step.fallbackWhy;
  return {
    stepId: step.id,
    phase: step.phase,
    title: step.title,
    // The model sometimes leaves a key fact out, or states a figure that
    // contradicts one: fix both in code.
    why: ensureFacts(grounded, facts, "sentences", { knownFacts: allFacts }).text,
    personalisedBecause: step.reason,
    deadline: resolveDeadline(step, str(written.deadline), evidenceText, facts, str(profile.arrival)),
    time: step.time,
    documents: supportedDocuments(written.documents, evidenceText),
    sourceUrl: chunk && isWebUrl(chunk.url) ? chunk.url : "",
    sourceTitle: chunk ? chunk.title : "",
    formId: form?.id ?? "",
    formUrl: form?.url ?? "",
    formLabel: form?.label ?? "",
    formLang: form?.lang ?? "",
    formKind: form?.kind ?? "",
  };
}

// --- Building a plan ---------------------------------------------------------------

type PreparedStep = {
  step: PlanStep;
  evidence: RetrievedChunk[];
  facts: Fact[];
  user: string;
  key: string;
};

/** Steps (from the rules) with their evidence and prompt (from the tools). No model involved. */
async function prepareSteps(profile: Profile, audience: Audience): Promise<PreparedStep[]> {
  const steps = planSteps(profile, audience);
  // Evidence per step, from the sources that fit its topic, this student's
  // citizenship group and their university. The query is the step's own (it
  // already reflects the answers that shape the step), so students in the same
  // situation get the same evidence — and share the written step.
  const hits = await retrievePerQuery(
    steps.map((step) => ({ query: step.query, topics: step.topics })),
    { status: str(profile.status), k: 3, institution: institutionFor(profile.university) },
  );
  // Key facts per step (the step ids work, insurance, registration and permit
  // are also fact topics). Their quotes go first in the step's evidence.
  const allFacts = loadFacts(audience);
  return steps.map((step, i) => {
    const facts = allFacts.filter((f) => f.topic === step.id);
    const evidence = hits[i].length ? [...facts.map(factChunk), ...hits[i]] : [];
    const user = stepPrompt(step, evidence, facts, profile, audience);
    return { step, evidence, facts, user, key: stepKey(user) };
  });
}

export type PlanEvent =
  | { type: "plan"; stops: PlanStop[] }
  | { type: "step"; index: number; stop: PlanStop }
  | { type: "done"; plan: PlanResult };

export type PlanResult = {
  stops: PlanStop[];
  sources: ReturnType<typeof sourceList>;
  model: string;
  /** True when every step was already written (nothing was generated now). */
  cached: boolean;
  /** How many steps the model wrote for this request. */
  written: number;
  note?: string;
};

// How many steps are sent to the model at once. Ollama answers them one after
// another unless it was started with OLLAMA_NUM_PARALLEL > 1, so a higher
// number here is harmless without it and faster with it.
const CONCURRENCY = Math.max(1, Number(process.env.PLAN_CONCURRENCY ?? 2));

// Students being served right now: background pre-writing waits for them.
let liveRequests = 0;

/**
 * Build the plan. `onEvent` receives the skeleton at once and each step when
 * its text is ready, so the app can show the plan while it is being written.
 * `fresh` ignores stored steps (used by the benchmark).
 */
export async function buildPlan(
  profile: Profile,
  audience: Audience,
  opts: { fresh?: boolean; onEvent?: (event: PlanEvent) => void } = {},
): Promise<PlanResult> {
  liveRequests++;
  try {
    const prepared = await prepareSteps(profile, audience);
    const allFacts = loadFacts(audience);
    const allowedForms = new Set(formsFor(audience).map((f) => f.id));
    const resolve = (p: PreparedStep, written: StepText) =>
      resolveStop(p.step, written, p.evidence, p.facts, allFacts, allowedForms, profile);

    if (prepared.every((p) => p.evidence.length === 0)) {
      return {
        stops: [],
        sources: [],
        model: LLM_MODEL,
        cached: false,
        written: 0,
        note: "Knowledge base is empty — build it first.",
      };
    }

    // The skeleton: every step with its rule-decided parts and, where the text
    // is already written, the finished step.
    const stored = prepared.map((p) => (opts.fresh ? undefined : readCachedStep(p.key)));
    const stops = prepared.map((p, i) => {
      const needsModel = !stored[i] && p.evidence.length > 0;
      return { ...resolve(p, stored[i] ?? {}), ...(needsModel ? { pending: true } : {}) };
    });
    opts.onEvent?.({ type: "plan", stops });

    // Write the missing steps, a few at a time, in plan order.
    const todo = prepared.map((_, i) => i).filter((i) => stops[i].pending);
    let written = 0;
    const worker = async () => {
      for (let i = todo.shift(); i !== undefined; i = todo.shift()) {
        const p = prepared[i];
        let text: StepText = {};
        try {
          text = await writeStep(p.user);
          writeCachedStep(p.key, p.step.id, text);
          written++;
        } catch (err) {
          // The step is known without the model: it keeps its short default text.
          console.warn(`Plan step "${p.step.id}" failed, using its default: ${(err as Error).message}`);
        }
        stops[i] = resolve(p, text);
        opts.onEvent?.({ type: "step", index: i, stop: stops[i] });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));

    // Every passage behind the plan, numbered once, for the source list.
    const seen = new Map<string, RetrievedChunk>();
    for (const p of prepared) for (const c of p.evidence) seen.set(chunkKey(c), c);
    const plan: PlanResult = {
      stops,
      sources: sourceList([...seen.values()]),
      model: LLM_MODEL,
      cached: stored.every((s, i) => s || prepared[i].evidence.length === 0),
      written,
    };
    opts.onEvent?.({ type: "done", plan });
    return plan;
  } finally {
    liveRequests--;
  }
}

// --- Writing steps ahead of time -------------------------------------------------
// The onboarding answers are multiple choice, so every step any student can
// get is known in advance. After a start-up or an ingest, they are written in
// the background; a student's own request always goes first.

const CHOICES = {
  university: ["Bern University of Applied Sciences", "University of Bern", "Other institution"],
  degree: ["Exchange semester", "Master’s degree"], // the rules only tell exchange from degree
  municipality: ["City of Bern", "Another municipality in the canton of Bern", "Not sure yet"],
  stayLength: [
    "Up to 3 months",
    "One semester (about 4–6 months)",
    "Two semesters (about 10–12 months)",
    "Longer than a year",
  ],
  housingStatus: ["Still looking", "Already arranged"],
  plansToWork: ["No", "Yes", "Not sure yet"],
  healthCoverage: [
    "European Health Insurance Card (EHIC)",
    "Private international insurance",
    "None / not sure",
  ],
};

function* everyProfile(): Generator<{ profile: Profile; audience: Audience }> {
  const keys = Object.keys(CHOICES) as (keyof typeof CHOICES)[];
  const pick = function* (i: number, profile: Profile): Generator<Profile> {
    if (i === keys.length) return yield profile;
    for (const value of CHOICES[keys[i]]) yield* pick(i + 1, { ...profile, [keys[i]]: value });
  };
  for (const audience of ["eu", "non-eu"] as const) {
    const status = audience === "eu" ? "EU / EFTA" : "Non-EU / EFTA";
    for (const profile of pick(0, { status, canton: "Bern" })) yield { profile, audience };
  }
}

let prewarming = false;
let prewarmAgain = false;

/** Write every step that isn't stored yet. Safe to call often: one run at a time. */
export async function prewarmPlans(): Promise<void> {
  if (process.env.PLAN_PREWARM === "false") return;
  if (prewarming) {
    prewarmAgain = true; // sources or facts changed mid-run: go round once more
    return;
  }
  prewarming = true;
  try {
    do {
      prewarmAgain = false;
      if (!kbStatus().ready || !(await llmAvailable())) return;
      // Collect the distinct steps first: thousands of profiles share a few hundred.
      const missing = new Map<string, PreparedStep>();
      for (const { profile, audience } of everyProfile()) {
        for (const p of await prepareSteps(profile, audience)) {
          if (p.evidence.length > 0 && !missing.has(p.key) && !readCachedStep(p.key)) {
            missing.set(p.key, p);
          }
        }
      }
      if (missing.size === 0) continue;
      console.log(`Plan steps: writing ${missing.size} ahead of time…`);
      const started = Date.now();
      let done = 0;
      for (const p of missing.values()) {
        // A student is waiting: stand aside until their plan is finished.
        while (liveRequests > 0) await new Promise((resolve) => setTimeout(resolve, 500));
        if (prewarmAgain) break;
        if (readCachedStep(p.key)) continue; // a student's request wrote it meanwhile
        try {
          writeCachedStep(p.key, p.step.id, await writeStep(p.user));
          done++;
        } catch (err) {
          console.warn(`Plan steps: "${p.step.id}" failed: ${(err as Error).message}`);
        }
      }
      console.log(`Plan steps: ${done} written in ${Math.round((Date.now() - started) / 1000)}s.`);
    } while (prewarmAgain);
    db.prepare(
      `DELETE FROM plan_step_cache WHERE created_at <= datetime('now', '-${STEP_CACHE_DAYS} days')`,
    ).run();
  } catch (err) {
    console.warn(`Plan steps: pre-writing stopped: ${(err as Error).message}`);
  } finally {
    prewarming = false;
  }
}

/** Is `status` a group plans exist for? (Helper for the routes.) */
export const planAudience = (status: unknown): Audience | null => audienceFor(str(status));
