// Key facts: the few figures every answer about a topic must get right (when a
// non-EU student may start working, the insurance deadline...).
//
// Only the QUESTIONS live in code. The answers are extracted from the official
// sources at every ingest, each with an exact quote that must appear in the
// source, so the AI can't invent one. When the law changes, the source changes,
// the next ingest extracts the new value and reports "6 months -> 3 months";
// nobody rewrites a rule. The chat and the plan then make sure every relevant
// fact appears in what students read (see ensureFacts).
//
// Review: the extraction model can misread a real quote (e.g. take an EU rule
// for non-EU students). So a new or changed fact is "pending" and is only used
// once someone approves it; a rejected value stays rejected until the source
// says something different.

import { addColumnIfMissing, db } from "./db.js";
import { chat, embedMany, EXTRACT_MODEL, stripThinking } from "./llm.js";
import { retrieve, RetrievedChunk } from "./knowledge.js";
import { numbersSupported, quantities, Quantity } from "./grounding.js";

export type FactTopic = "work" | "insurance" | "registration" | "permit";
type Audience = "eu" | "non-eu" | "all";

type FactQuestion = {
  id: string;
  topic: FactTopic;
  audience: Audience;
  /** Asked of the sources. Says what to find, never the answer. */
  question: string;
};

export const FACT_QUESTIONS: FactQuestion[] = [
  // Working while studying
  {
    id: "work-start-non-eu",
    topic: "work",
    audience: "non-eu",
    question: "How long after the start of their studies may non-EU/EFTA students start working part-time?",
  },
  {
    id: "work-hours-non-eu",
    topic: "work",
    audience: "non-eu",
    question: "How many hours per week may non-EU/EFTA students work during the semester?",
  },
  {
    id: "work-breaks-non-eu",
    topic: "work",
    audience: "non-eu",
    question: "How much may non-EU/EFTA students work during semester breaks, and under what condition?",
  },
  {
    id: "work-approval-non-eu",
    topic: "work",
    audience: "non-eu",
    question: "Who must apply for or approve a non-EU/EFTA student's job before they start working?",
  },
  {
    id: "work-hours-eu",
    topic: "work",
    audience: "eu",
    question: "How many hours per week may EU/EFTA students work during the semester?",
  },
  {
    id: "work-breaks-eu",
    topic: "work",
    audience: "eu",
    question: "How much may EU/EFTA students work during semester breaks?",
  },
  // Health insurance
  {
    id: "insurance-deadline",
    topic: "insurance",
    audience: "all",
    question: "Within what time must someone who becomes subject to Swiss compulsory health insurance take out basic insurance?",
  },
  {
    id: "insurance-late",
    topic: "insurance",
    audience: "all",
    question: "What happens if someone takes out Swiss basic health insurance late or not at all?",
  },
  {
    id: "insurance-work",
    topic: "insurance",
    audience: "all",
    question: "Does taking up work in Switzerland make Swiss basic health insurance compulsory for students insured in their home country?",
  },
  {
    id: "exemption-deadline",
    topic: "insurance",
    audience: "all",
    question: "Within what time must a student apply for exemption from Swiss compulsory health insurance?",
  },
  // Registration
  {
    id: "registration-deadline",
    topic: "registration",
    audience: "all",
    question: "Within how many days after arrival must students register with the municipality where they live?",
  },
  // Visa and permit before travelling
  {
    id: "permit-processing-non-eu",
    topic: "permit",
    audience: "non-eu",
    question: "How long does it take to process a non-EU/EFTA student's visa or residence permit application for studies?",
  },
  {
    id: "permit-where-non-eu",
    topic: "permit",
    audience: "non-eu",
    // Worded to keep it apart from registering with the municipality after
    // arrival, which the extractor once returned as the answer.
    question: "Before travelling to Switzerland, at which office abroad do non-EU/EFTA students apply for their visa for studies?",
  },
];

// Which topics a question or a plan step is about. Plain keywords, so it's
// predictable which facts an answer is held to.
const TOPIC_PATTERNS: Record<FactTopic, RegExp> = {
  work: /\b(work\w*|jobs?|employ\w*|part[- ]time|salary|wages?|arbeit\w*)\b/i,
  insurance: /\b(insur\w*|health|ehic|exempt\w*|krankenkasse|krankenversicherung)\b/i,
  registration: /\b(regist\w*|anmeld\w*|arriv\w*|commune|municipal\w*)\b/i,
  permit: /\b(visa|permits?|embassy|consulate|entry|enter switzerland)\b/i,
};

export function topicsIn(text: string): FactTopic[] {
  return (Object.keys(TOPIC_PATTERNS) as FactTopic[]).filter((t) => TOPIC_PATTERNS[t].test(text));
}

// How closely a student's question must match a fact's own question for that
// fact to be required in the answer. Calibrated on a handful of questions: the
// right facts scored 0.55-0.72, unrelated ones mostly below 0.50 — but meaning
// alone misfires ("phone number" scored 0.61 against insurance), so the topic
// keyword must match too.
const FACT_MATCH = 0.55;
const questionVectors = new Map<string, number[]>();

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** The facts a question is really about: same topic, and close in meaning. */
export async function relevantFacts(question: string, facts: Fact[]): Promise<Fact[]> {
  const topics = topicsIn(question);
  const candidates = facts.filter((f) => topics.includes(f.topic));
  if (candidates.length === 0) return [];
  const missing = candidates.map((f) => f.question).filter((q) => !questionVectors.has(q));
  const vectors = await embedMany([question, ...missing], "query");
  missing.forEach((q, i) => questionVectors.set(q, vectors[i + 1]));
  return candidates.filter((f) => cosine(vectors[0], questionVectors.get(f.question)!) >= FACT_MATCH);
}

// --- Storage -----------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS kb_facts (
    question_id    TEXT PRIMARY KEY,
    value          TEXT NOT NULL,
    quote          TEXT NOT NULL,
    title          TEXT NOT NULL,
    url            TEXT NOT NULL,
    extracted_at   TEXT NOT NULL DEFAULT (datetime('now')),
    previous_value TEXT,
    changed_at     TEXT
  );
`);
addColumnIfMissing("kb_facts", "status", "TEXT NOT NULL DEFAULT 'pending'");

export type FactStatus = "pending" | "approved" | "rejected";

export type Fact = {
  id: string;
  topic: FactTopic;
  audience: Audience;
  question: string;
  value: string;
  quote: string;
  title: string;
  url: string;
  extractedAt: string;
  previousValue: string | null;
  changedAt: string | null;
  status: FactStatus;
};

type FactRow = {
  question_id: string;
  value: string;
  quote: string;
  title: string;
  url: string;
  extracted_at: string;
  previous_value: string | null;
  changed_at: string | null;
  status: FactStatus;
};

/**
 * The stored facts for this student's group (or all, when audience is null).
 * Answers use approved facts only; the review list shows every status.
 */
export function loadFacts(
  audience: "eu" | "non-eu" | null,
  opts: { approvedOnly?: boolean } = { approvedOnly: true },
): Fact[] {
  const rows = (db.prepare("SELECT * FROM kb_facts").all() as FactRow[]).filter(
    (r) => !opts.approvedOnly || r.status === "approved",
  );
  const byId = new Map(rows.map((r) => [r.question_id, r]));
  return FACT_QUESTIONS.filter(
    (q) =>
      audience === null || q.audience === "all" || q.audience === audience,
  ).flatMap((q) => {
    const r = byId.get(q.id);
    if (!r) return [];
    return [
      {
        id: q.id,
        topic: q.topic,
        audience: q.audience,
        question: q.question,
        value: r.value,
        quote: r.quote,
        title: r.title,
        url: r.url,
        extractedAt: r.extracted_at,
        previousValue: r.previous_value,
        changedAt: r.changed_at,
        status: r.status,
      },
    ];
  });
}

// --- Extraction ----------------------------------------------------------------

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    value: { type: "string" },
    quote: { type: "string" },
    sourceNumber: { type: "integer" },
  },
  required: ["found", "value", "quote", "sourceNumber"],
};

// Quotes are compared ignoring case, spacing and PDF line-break hyphens
// ("Erwerbstä- tigkeit").
export const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/(\w)-\s+(\w)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();

const STATUS: Record<Audience, string | undefined> = {
  eu: "EU / EFTA",
  "non-eu": "Non-EU / EFTA",
  all: undefined,
};

const GROUP: Record<Audience, string> = {
  eu: "EU/EFTA students",
  "non-eu": "non-EU/EFTA students",
  all: "students (any citizenship)",
};

async function extractOne(q: FactQuestion) {
  // Official sources only: coordinator notes are guidance, not the rule.
  const official = (await retrieve(q.question, { status: STATUS[q.audience], k: 14 })).filter(
    (c) => c.authority === "official",
  );
  // A fact is shown to students of every university, so the authorities' own
  // pages come before one university's summary of them.
  const evidence = [
    ...official.filter((c) => !c.institution),
    ...official.filter((c) => c.institution),
  ].slice(0, 6);
  if (evidence.length === 0) return null;

  const sources = evidence.map((c, i) => `[${i + 1}] ${c.title}\n${c.text}`).join("\n\n");
  const messages = [
      {
        role: "system" as const,
        content: [
          "You extract one fact from official Swiss sources. Use ONLY the SOURCES.",
          `The fact must apply to ${GROUP[q.audience]}. Many sources give different rules for EU/EFTA and non-EU/EFTA nationals, or for workers, cross-border commuters and family members: read which group a sentence is about, and never use a sentence written for another group.`,
          "The quote must answer THIS question, not a neighbouring one: e.g. how long an exemption lasts is not a deadline for applying, and registering with a municipality is not applying for a visa.",
          "The value must say only what the quote says. Don't add, reverse or generalise it.",
          "If no single sentence in the sources clearly answers the question for this group, return found=false with empty strings. A missing fact is fine; a wrong one is harmful.",
          "value: the answer in one short English sentence (at most 20 words), keeping the exact figures and units.",
          "quote: one sentence copied character for character from a single source (it may be German) that states the fact.",
          "sourceNumber: the number of that source.",
        ].join("\n"),
      },
      { role: "user" as const, content: `SOURCES:\n${sources}\n\n---\nQUESTION: ${q.question}` },
  ];
  type Parsed = { found?: boolean; value?: string; quote?: string; sourceNumber?: number };
  const ask = async (think: boolean): Promise<Parsed | null> => {
    const reply = await chat(messages, {
      temperature: 0,
      format: EXTRACT_SCHEMA,
      think,
      model: EXTRACT_MODEL,
      // At temperature 0 the reasoning pass can get stuck repeating itself and
      // never finish (it once ran for over 20 minutes on one question). The
      // cap stops it; the question is then asked again without reasoning.
      maxTokens: think ? 6000 : 1000,
    });
    try {
      return JSON.parse(stripThinking(reply)) as Parsed;
    } catch {
      return null; // cut off by the cap, or not JSON
    }
  };
  // Extraction runs only at ingest, so it can afford the model's reasoning pass
  // (EXTRACT_THINK=false turns it off).
  const think = process.env.EXTRACT_THINK !== "false";
  const parsed = (await ask(think)) ?? (think ? await ask(false) : null);
  if (!parsed) return null;
  const value = (parsed.value ?? "").trim();
  const quote = (parsed.quote ?? "").trim();
  const source: RetrievedChunk | undefined = evidence[(parsed.sourceNumber ?? 0) - 1];
  if (!parsed.found || !value || quote.length < 15 || !source) return null;
  // The proof: the quote must really be in that source, and every figure in the
  // value must be in the quote.
  if (!normalize(source.text).includes(normalize(quote))) return null;
  if (!numbersSupported(value, quote)) return null;
  return { value, quote, title: source.title, url: source.url };
}

export type FactsReport = {
  extracted: number;
  missing: string[];
  changed: { id: string; from: string; to: string }[];
};

/** (Re)extract every key fact. Unchanged values keep their history quiet. */
export async function extractFacts(): Promise<FactsReport> {
  const report: FactsReport = { extracted: 0, missing: [], changed: [] };
  const previous = db.prepare("SELECT value FROM kb_facts WHERE question_id = ?");
  // A changed value goes back to "pending" for review; an unchanged one keeps
  // its status (approved stays approved, rejected stays rejected).
  const save = db.prepare(`
    INSERT INTO kb_facts (question_id, value, quote, title, url, extracted_at, status)
    VALUES (@id, @value, @quote, @title, @url, datetime('now'), 'pending')
    ON CONFLICT(question_id) DO UPDATE SET
      previous_value = CASE WHEN kb_facts.value != excluded.value THEN kb_facts.value ELSE kb_facts.previous_value END,
      changed_at     = CASE WHEN kb_facts.value != excluded.value THEN datetime('now') ELSE kb_facts.changed_at END,
      status         = CASE WHEN kb_facts.value != excluded.value THEN 'pending' ELSE kb_facts.status END,
      value = excluded.value, quote = excluded.quote, title = excluded.title,
      url = excluded.url, extracted_at = excluded.extracted_at
  `);
  const remove = db.prepare("DELETE FROM kb_facts WHERE question_id = ?");

  for (const q of FACT_QUESTIONS) {
    let fact: Awaited<ReturnType<typeof extractOne>> = null;
    try {
      fact = await extractOne(q);
    } catch (err) {
      console.warn(`Fact ${q.id}: ${(err as Error).message}`);
    }
    const before = previous.get(q.id) as { value: string } | undefined;
    if (!fact) {
      // Unconfirmed facts are dropped rather than kept stale.
      remove.run(q.id);
      report.missing.push(q.id);
      continue;
    }
    // Only a change in the figures counts as a change of the rule; rewording
    // by the model doesn't.
    if (before && !sameQuantities(before.value, fact.value)) {
      report.changed.push({ id: q.id, from: before.value, to: fact.value });
      save.run({ id: q.id, ...fact });
    } else if (!before) {
      save.run({ id: q.id, ...fact });
    } else {
      // Same rule, new wording: refresh the quote and source, keep the value stable.
      save.run({ id: q.id, ...fact, value: before.value });
    }
    report.extracted++;
  }
  return report;
}

const key = (q: Quantity) => `${q.n} ${q.unit}`;

// Facts with figures change when a figure changes. Facts without figures
// ("the employer must apply") are compared as text; extraction runs at
// temperature 0, so the wording is stable while the source is unchanged.
function sameQuantities(a: string, b: string): boolean {
  const qa = quantities(a).map(key).sort().join(",");
  const qb = quantities(b).map(key).sort().join(",");
  if (qa !== qb) return false;
  return qa !== "" || normalize(a) === normalize(b);
}

// --- Holding answers to the facts ----------------------------------------------

/**
 * Make a text agree with the facts it is about:
 *  - a sentence on a fact's topic with a figure in the same unit that no fact
 *    supports ("insurance by the end of the first month" vs "3 months") is removed;
 *  - a fact whose figure the text doesn't mention is added.
 * Facts without figures can't be checked this way and are left to the prompt.
 */
export function ensureFacts(
  text: string,
  facts: Fact[],
  mode: "bullets" | "sentences",
  options: { citation?: (fact: Fact) => string; knownFacts?: Fact[] } = {},
): { text: string; added: number; removed: number } {
  const citation = options.citation ?? (() => "");
  const factQuantities = facts.map((f) => ({ fact: f, qs: quantities(f.value) }));
  // Figures any of the student's facts support (not only this topic's), so a
  // sentence that mentions another rule correctly isn't removed.
  const known = new Set(
    [...facts, ...(options.knownFacts ?? [])].flatMap((f) => quantities(f.value).map(key)),
  );
  let removed = 0;

  const contradicts = (sentence: string) =>
    factQuantities.some(
      ({ fact, qs }) =>
        TOPIC_PATTERNS[fact.topic].test(sentence) &&
        quantities(sentence).some(
          (q) => qs.some((fq) => fq.unit === q.unit) && !known.has(key(q)),
        ),
    );

  const lines = text.split("\n").flatMap((line) => {
    const [, marker = "", body = line] = line.match(/^(\s*(?:[-*•]|\d+[.)])\s+)(.*)$/) ?? [];
    const kept = body.trim().split(/(?<=[.!?])\s+/).filter(Boolean).filter((sentence) => {
      if (!contradicts(sentence)) return true;
      removed++;
      return false;
    });
    if (kept.length === 0) return body.trim() ? [] : [line];
    return [marker + kept.join(" ")];
  });

  const present = new Set(quantities(lines.join(" ")).map(key));
  const missing = factQuantities.filter(
    ({ qs }) => qs.length > 0 && !qs.every((q) => present.has(key(q))),
  );

  let result = lines.join("\n").trim();
  if (missing.length > 0) {
    const additions = missing.map(({ fact }) => {
      const value = fact.value.replace(/\.?\s*$/, ".");
      const cite = citation(fact);
      return mode === "bullets" ? `- ${value}${cite ? ` ${cite}` : ""}` : value;
    });
    if (mode === "bullets") {
      // Before the closing "confirm on the official source" line, if there is one.
      const all = result.split("\n");
      const closing = all.length > 1 && /confirm/i.test(all[all.length - 1]) ? all.pop()! : null;
      result = [...all, ...additions, ...(closing ? [closing] : [])].join("\n");
    } else {
      result = `${result.replace(/\s*$/, "")} ${additions.join(" ")}`.trim();
    }
  }
  return { text: result, added: missing.length, removed };
}

/** A reviewer confirms or rejects an extracted fact. */
export function reviewFact(id: string, status: "approved" | "rejected"): boolean {
  return db.prepare("UPDATE kb_facts SET status = ? WHERE question_id = ?").run(status, id).changes > 0;
}
