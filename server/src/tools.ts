// The AI's tools: the ONLY things it can do besides writing text.
//
// A language model on its own can only produce words. A "tool" is a function
// in our code that we describe to the model (a name, when to use it, which
// arguments it takes). The model can then answer "run search_sources with
// query = ..." instead of guessing; the server runs the function and hands the
// result back. The model never touches the database, the network or the clock
// itself — and it cannot do anything that isn't in this list.
//
// Each tool here has one job and a narrow contract:
//   - what goes in is validated (unknown topics, dates and units are refused);
//   - what comes out is something the code already trusts (allow-listed
//     sources, approved facts, the rule-decided plan, the curated forms).
//
// The same functions are used in two ways:
//   - the PLAN calls them from code, in a fixed order (plan.ts). Nothing is
//     left to the model there, because every student needs the same lookups.
//   - the CHAT lets the model call them (index.ts), because only the question
//     tells which lookup is needed. Rounds are capped; see CHAT_TOOL_ROUNDS.

import type { ToolSpec } from "./llm.js";
import { audienceFor, institutionFor, retrieve, RetrievedChunk } from "./knowledge.js";
import { Fact, loadFacts } from "./facts.js";
import { formsFor } from "./forms.js";
import { formatDate, planSteps } from "./plan-rules.js";
import type { Topic } from "./sources.js";

type Profile = Record<string, unknown>;

/** What a tool may know about the student it is running for. */
export type ToolContext = { profile: Profile };

export type Tool = {
  name: string;
  /** Shown to the model: what the tool returns and when to use it. */
  description: string;
  /** JSON schema of the arguments, also shown to the model. */
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, context: ToolContext): Promise<unknown> | unknown;
};

const TOPICS: Topic[] = [
  "housing",
  "visa",
  "registration",
  "insurance",
  "work",
  "social-insurance",
  "tax",
  "household-fee",
  "departure",
  "general",
];

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const status = (profile: Profile) => text(profile.status);

// --- Dates ----------------------------------------------------------------------

export type TimeUnit = "day" | "week" | "month" | "year";

/**
 * A date plus a period, as an ISO date ("2026-08-24" + 14 days -> "2026-09-07").
 * Models are unreliable at calendar arithmetic, so dates are always computed here.
 * Returns "" when the start isn't a real date.
 */
export function addToDate(startIso: string, amount: number, unit: TimeUnit): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startIso) || !Number.isInteger(amount) || amount < 0) return "";
  const date = new Date(`${startIso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  if (unit === "day") date.setUTCDate(date.getUTCDate() + amount);
  else if (unit === "week") date.setUTCDate(date.getUTCDate() + amount * 7);
  else {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + amount * (unit === "year" ? 12 : 1));
    // 31 Jan + 1 month is the last day of February, not 3 March.
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  }
  return date.toISOString().slice(0, 10);
}

// --- The tools --------------------------------------------------------------------

/** Passages from the official sources, already filtered to this student's group and university. */
export function searchSources(
  query: string,
  context: ToolContext,
  k = 4,
): Promise<RetrievedChunk[]> {
  return retrieve(query, {
    status: status(context.profile),
    institution: institutionFor(context.profile.university),
    k,
  });
}

/** Approved key facts for this student's group, optionally for one topic. */
export function keyFacts(context: ToolContext, topic?: string): Fact[] {
  const facts = loadFacts(audienceFor(status(context.profile)));
  return topic ? facts.filter((f) => f.topic === topic) : facts;
}

export const TOOLS: Tool[] = [
  {
    name: "search_sources",
    description:
      "Search the official Swiss sources (federal, Canton of Bern, City of Bern, the student's university) and the coordinator notes. Returns numbered passages you can cite. Use it when the CONTEXT you were given doesn't contain what the question asks about.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to look for, as a full question or phrase, in English or German.",
        },
      },
      required: ["query"],
    },
    run: async (args, context) => {
      const query = text(args.query).slice(0, 300);
      if (!query) throw new Error("query is required");
      return searchSources(query, context);
    },
  },
  {
    name: "get_key_facts",
    description:
      "The figures HelvetiStart has checked against the official sources for this student's citizenship group (work hours, insurance and registration deadlines, permit processing). Use it for any question about a deadline or a limit.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", enum: ["work", "insurance", "registration", "permit"] },
      },
      required: ["topic"],
    },
    run: (args, context) =>
      keyFacts(context, text(args.topic)).map((f) => ({
        fact: f.value,
        quote: f.quote,
        source: f.title,
      })),
  },
  {
    name: "get_plan_steps",
    description:
      "The steps of this student's relocation plan, in order, as decided by HelvetiStart's rules from their answers. Use it when the student asks what to do next, what their plan contains, or why a step is in it.",
    parameters: { type: "object", properties: {} },
    run: (_args, context) => {
      const audience = audienceFor(status(context.profile));
      if (!audience) return [];
      return planSteps(context.profile, audience).map((step) => ({
        step: step.title,
        phase: step.phase,
        why: step.reason,
        covers: step.brief,
      }));
    },
  },
  {
    name: "calculate_deadline",
    description:
      "Work out a calendar date from a start date and a period given in a source (e.g. 14 days after arrival). ALWAYS use it instead of calculating a date yourself.",
    parameters: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "ISO date, e.g. 2026-08-24" },
        amount: { type: "integer", minimum: 0 },
        unit: { type: "string", enum: ["day", "week", "month", "year"] },
      },
      required: ["start_date", "amount", "unit"],
    },
    run: (args) => {
      const unit = text(args.unit) as TimeUnit;
      if (!["day", "week", "month", "year"].includes(unit)) throw new Error("unknown unit");
      const iso = addToDate(text(args.start_date), Number(args.amount), unit);
      if (!iso) throw new Error("start_date must be a date like 2026-08-24");
      return { date: iso, text: formatDate(iso) };
    },
  },
  {
    name: "find_form",
    description:
      "Official forms and application pages HelvetiStart has checked, for this student's citizenship group. Use it when the student asks where or how to apply, register or deregister. Never give a form link that didn't come from this tool or the CONTEXT.",
    parameters: {
      type: "object",
      properties: { topic: { type: "string", enum: TOPICS } },
      required: ["topic"],
    },
    run: (args, context) =>
      formsFor(audienceFor(status(context.profile)))
        .filter((f) => f.topic === text(args.topic))
        .map((f) => ({ label: f.label, url: f.url, validFor: f.scope, language: f.lang })),
  },
];

/** The tools as the model sees them. */
export const TOOL_SPECS: ToolSpec[] = TOOLS.map((tool) => ({
  type: "function",
  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
}));

/**
 * Run a tool the model asked for. An unknown tool or bad arguments come back
 * as an error message for the model to read; nothing is ever executed outside
 * the list above.
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<{ ok: boolean; result: unknown }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, result: `Unknown tool "${name}".` };
  try {
    return { ok: true, result: await tool.run(args ?? {}, context) };
  } catch (err) {
    return { ok: false, result: `Tool error: ${(err as Error).message}` };
  }
}
