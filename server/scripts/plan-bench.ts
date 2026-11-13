// Plan benchmark: runs fixed student scenarios through /api/plan, times them,
// and checks each plan against what the form catalogue and coordinator notes
// require. Run it before and after a change to see whether it helped.
//
// Each scenario is built twice: first with nothing stored (every step written
// by the model — the slowest a student can ever wait; it must stay under
// TARGET_SECONDS), then again from the stored steps (what most students get).
//
//   npm run bench                 (backend must be running on :3001)
//   npm run bench -- exchange     (only scenarios whose name contains "exchange")
//
// Expectations come from forms.ts scopes and knowledge/coordinator-eu-exchange.md.
// Have a coordinator confirm them before trusting the scores.

export {}; // top-level await needs this file to be a module

const API = process.env.API_BASE ?? "http://localhost:3001";

const base = {
  firstName: "Alex",
  nationality: "Croatia",
  age: "22",
  university: "Bern University of Applied Sciences",
  degree: "Exchange semester",
  canton: "Bern",
  arrival: "2026-08-24",
  stayLength: "One semester (about 4–6 months)",
  municipality: "City of Bern",
  housingStatus: "Still looking",
  plansToWork: "No",
  healthCoverage: "European Health Insurance Card (EHIC)",
};

// A non-EU student (visa and permit before travelling, different forms).
const nonEu = {
  ...base,
  nationality: "United States",
  healthCoverage: "Private international insurance",
};

// A student should never wait longer than this for a complete plan.
const TARGET_SECONDS = 60;

type Topic =
  | "housing"
  | "permit"
  | "registration"
  | "insurance"
  | "work"
  | "bank"
  | "phone"
  | "payroll"
  | "household-fee"
  | "permit-renewal"
  | "departure";

// How a step's title shows which topic it covers.
const TOPIC_PATTERNS: Record<Topic, RegExp> = {
  housing: /accommodation|housing|room|flat|place to (live|stay)/i,
  permit: /visa/i,
  registration: /^register/i,
  insurance: /insurance|exempt/i,
  work: /\bwork|job|employ/i,
  bank: /bank/i,
  phone: /phone|sim\b|mobile/i,
  payroll: /payslip/i,
  "household-fee": /radio|serafe/i,
  "permit-renewal": /^renew/i,
  departure: /^deregister/i,
};

type Scenario = {
  name: string;
  profile: Record<string, string>;
  unsupported?: boolean;
  forms?: string[];
  noForms?: string[];
  topics?: Topic[];
  noTopics?: Topic[];
  /** Facts the plan's text must contain. They are not in the rules, so they can only come from the sources. */
  mentions?: RegExp[];
  /** Facts that must NOT appear, e.g. another canton's rule. */
  noMentions?: RegExp[];
  /** No step may cite a source whose title matches (e.g. another university's pages). */
  noSources?: RegExp;
};

const SCENARIOS: Scenario[] = [
  {
    name: "exchange-city-of-bern",
    profile: base,
    forms: ["bern-exchange-registration", "asv-form-a", "bern-departure-abroad"],
    noForms: ["bern-eu-student-registration"],
    topics: ["housing", "registration", "insurance", "household-fee", "departure"],
    noTopics: ["bank", "payroll", "permit-renewal"],
  },
  {
    name: "degree-city-of-bern",
    profile: { ...base, degree: "Master’s degree", stayLength: "Longer than a year" },
    forms: ["bern-eu-student-registration"],
    noForms: ["bern-exchange-registration", "bern-departure-abroad"],
    // Staying for years: the permit is renewed; leaving isn't planned yet.
    topics: ["housing", "registration", "insurance", "permit-renewal"],
    noTopics: ["departure"],
  },
  {
    // A University of Bern student must not be sent to BFH's pages or housing office.
    name: "exchange-university-of-bern",
    profile: { ...base, university: "University of Bern" },
    forms: ["bern-exchange-registration"],
    noForms: ["bfh-housing"],
    topics: ["housing", "registration", "insurance"],
    noSources: /\bBFH\b/,
  },
  {
    name: "exchange-other-municipality",
    profile: { ...base, municipality: "Another municipality in the canton of Bern" },
    noForms: ["bern-exchange-registration", "bern-eu-student-registration", "bern-departure-abroad"],
    topics: ["registration", "insurance", "departure"],
  },
  {
    name: "exchange-housing-arranged",
    profile: { ...base, housingStatus: "Already arranged" },
    forms: ["bern-exchange-registration"],
    noTopics: ["housing"],
  },
  {
    name: "exchange-plans-to-work",
    profile: { ...base, plansToWork: "Yes" },
    forms: ["bern-exchange-registration", "bern-work-permits"],
    noForms: ["asv-form-a"], // working generally rules out the exemption
    topics: ["registration", "insurance", "work", "bank", "payroll"],
    mentions: [/15 hours/i], // Bern's study-stay page: EU/EFTA students, during the semester
  },
  {
    name: "exchange-no-home-cover",
    profile: { ...base, healthCoverage: "None / not sure" },
    noForms: ["asv-form-a"],
    topics: ["insurance"],
  },
  {
    name: "exchange-short-stay",
    profile: { ...base, stayLength: "Up to 3 months" },
    topics: ["registration"],
  },
  {
    name: "dual-national-eu",
    profile: { ...base, nationality: "German / US" },
    forms: ["bern-exchange-registration"],
  },
  {
    name: "non-eu-exchange-city-of-bern",
    profile: { ...nonEu },
    forms: ["eda-representations", "bern-thirdcountry-registration", "asv-form-a"],
    noForms: ["bern-exchange-registration", "bern-eu-student-registration"],
    topics: ["housing", "permit", "registration", "insurance"],
    noTopics: ["bank"],
  },
  {
    name: "non-eu-plans-to-work",
    profile: { ...nonEu, plansToWork: "Yes" },
    forms: ["bern-thirdcountry-registration", "awi-job-start"],
    noForms: ["asv-form-a"], // working rules out the exemption
    topics: ["permit", "registration", "insurance", "work", "bank", "payroll", "departure"],
    // SEM work FAQ / BFH: not before six months after the course starts, 15 hours a week.
    mentions: [/(six|6) months/i, /15 hours/i],
  },
  {
    // The EHIC is only for EU/EFTA citizens, so it can't support an exemption.
    name: "non-eu-chose-ehic",
    profile: { ...nonEu, healthCoverage: "European Health Insurance Card (EHIC)" },
    noForms: ["asv-form-a"],
    topics: ["insurance"],
  },
  {
    name: "unknown-citizenship-unsupported",
    profile: { ...base, nationality: "" },
    unsupported: true,
  },
];

type Stop = {
  title: string;
  why?: string;
  personalisedBecause?: string;
  deadline?: string;
  formId?: string;
  sourceUrl?: string;
  sourceTitle?: string;
};
type PlanResponse = {
  stops?: Stop[];
  unsupported?: boolean;
  cached?: boolean;
  written?: number;
  error?: string;
};

async function requestPlan(profile: Record<string, string>, fresh: boolean) {
  const started = performance.now();
  const res = await fetch(`${API}/api/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile, fresh }),
  });
  const data = (await res.json()) as PlanResponse;
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return { data, seconds: (performance.now() - started) / 1000 };
}

function check(s: Scenario, plan: PlanResponse): string[] {
  const failures: string[] = [];
  if (s.unsupported) {
    if (!plan.unsupported) failures.push("expected 'unsupported'");
    return failures;
  }
  const stops = plan.stops ?? [];
  if (stops.length === 0) return ["no stops"];
  const formIds = new Set(stops.map((st) => st.formId).filter(Boolean));
  const covers = (t: Topic) => stops.some((st) => TOPIC_PATTERNS[t].test(st.title));

  for (const f of s.forms ?? []) if (!formIds.has(f)) failures.push(`missing form ${f}`);
  for (const f of s.noForms ?? []) if (formIds.has(f)) failures.push(`wrong form ${f}`);
  for (const t of s.topics ?? []) if (!covers(t)) failures.push(`missing ${t} step`);
  for (const t of s.noTopics ?? []) if (covers(t)) failures.push(`unneeded ${t} step`);
  const text = stops
    .map((st) => [st.title, st.why, st.personalisedBecause, st.deadline].join(" "))
    .join(" ");
  for (const re of s.mentions ?? []) if (!re.test(text)) failures.push(`doesn't mention ${re}`);
  for (const re of s.noMentions ?? []) if (re.test(text)) failures.push(`mentions ${re}`);
  const unsourced = stops.filter((st) => !st.sourceTitle).length;
  if (unsourced) failures.push(`${unsourced} step(s) without a source`);
  const wrongSource = stops.filter((st) => s.noSources?.test(st.sourceTitle ?? ""));
  for (const st of wrongSource) failures.push(`"${st.title}" cites ${st.sourceTitle}`);
  const unexplained = stops.filter((st) => !st.personalisedBecause).length;
  if (unexplained) failures.push(`${unexplained} step(s) without a reason`);
  return failures;
}

const filter = process.argv[2] ?? "";
const scenarios = SCENARIOS.filter((s) => s.name.includes(filter));
let passed = 0;
let totalSeconds = 0;
let slowest = 0;
let storedSeconds = 0;

for (const s of scenarios) {
  try {
    // Nothing stored: the model writes every step.
    const { data, seconds } = await requestPlan(s.profile, true);
    totalSeconds += seconds;
    slowest = Math.max(slowest, seconds);
    const failures = check(s, data);
    if (seconds > TARGET_SECONDS) failures.push(`took longer than ${TARGET_SECONDS}s`);
    // Again from the stored steps: the checks must hold there too.
    const again = await requestPlan(s.profile, false);
    storedSeconds += again.seconds;
    if (!s.unsupported && !again.data.cached) failures.push("second request wasn't served from stored steps");
    if (failures.length === 0) passed++;
    const status = failures.length ? `FAIL  ${failures.join("; ")}` : "ok";
    console.log(
      `${s.name.padEnd(32)} ${seconds.toFixed(1).padStart(6)}s new ${again.seconds.toFixed(2).padStart(6)}s stored  ${status}`,
    );
    for (const st of data.stops ?? []) {
      console.log(`    - ${st.title}${st.formId ? `  [${st.formId}]` : ""}${st.deadline ? `  · ${st.deadline}` : ""}`);
    }
  } catch (err) {
    console.log(`${s.name.padEnd(32)}  ERROR ${(err as Error).message}`);
  }
}

const n = Math.max(scenarios.length, 1);
console.log(
  `\n${passed}/${scenarios.length} passed. Nothing stored: ${(totalSeconds / n).toFixed(1)}s average, ` +
    `${slowest.toFixed(1)}s slowest (target: under ${TARGET_SECONDS}s). ` +
    `From stored steps: ${(storedSeconds / n).toFixed(2)}s average.`,
);

// What the app does: read the plan as a stream. How long until the student
// sees their steps, and until every step's details are written?
const first = scenarios.find((s) => !s.unsupported);
if (first) {
  const started = performance.now();
  const res = await fetch(`${API}/api/plan/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile: first.profile, fresh: true }),
  });
  let shown = 0;
  let firstDetail = 0;
  const decoder = new TextDecoder();
  for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
    const text = decoder.decode(bytes, { stream: true });
    const now = (performance.now() - started) / 1000;
    if (!shown && text.includes('"type":"plan"')) shown = now;
    if (!firstDetail && text.includes('"type":"step"')) firstDetail = now;
  }
  const finished = (performance.now() - started) / 1000;
  console.log(
    `Streamed ${first.name} with nothing stored: steps on screen after ${shown.toFixed(2)}s, ` +
      `first details after ${firstDetail.toFixed(1)}s, complete after ${finished.toFixed(1)}s.`,
  );
}
