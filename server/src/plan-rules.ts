// Which steps a student's plan contains, in what order, and which form each one
// links to. These decisions are made here, in code, from the onboarding
// answers — not by the AI. The AI only writes each step's text (see /api/plan).
//
// Rules decide STRUCTURE only. They never state facts such as hour limits,
// deadlines or fees: those change with the law, so they come from the sources
// (official pages and coordinator notes), and a re-ingest picks up a change.
// A brief says WHAT to explain; the evidence says what it is.
//
// Two more things are decided here because the rules know them exactly and the
// model would only guess: WHY a step is in this student's plan (`reason`, built
// from the answer that put it there) and roughly how long it takes (`time`, a
// coordinator's estimate, not a rule).
//
// The rules follow knowledge/coordinator-eu-exchange.md and the scopes in
// forms.ts. A coordinator should confirm them; the benchmark (npm run bench)
// checks plans against the same expectations.

import type { Topic } from "./sources.js";

type Profile = Record<string, unknown>;

export type PlanStep = {
  id: string;
  phase: string;
  title: string;
  /** Search query for this step's evidence. */
  query: string;
  /** Source topics the evidence may come from (coordinator notes are always included). */
  topics: Topic[];
  /** What the AI's text for this step must cover, given this student's answers. */
  brief: string;
  /** Shown if the AI returns nothing usable for this step. */
  fallbackWhy: string;
  /** Curated form id from forms.ts, or undefined for no form. */
  formId?: string;
  /** Why this step is in THIS student's plan: the answer that put it there. */
  reason: string;
  /** Rough effort, a coordinator's estimate (not a rule). */
  time: string;
  /**
   * Profile answers the step's text depends on, beyond what the brief already
   * says. Only these are shown to the model for this step, so two students who
   * differ elsewhere share the same written step (see plan.ts).
   */
  uses?: string[];
  /**
   * Key facts (facts.ts) that state this step's deadline, most specific first.
   * An approved one sets the deadline in code instead of leaving it to the model.
   */
  deadlineFacts?: string[];
  /** What the deadline counts from. Only "arrival" can be turned into a date. */
  deadlineFrom?: "arrival" | "job-start";
};

/** Source topics each step draws its evidence from (coordinator notes always count). */
export const STEP_TOPICS: Record<string, Topic[]> = {
  housing: ["housing"],
  permit: ["visa", "registration"],
  registration: ["registration", "visa"],
  // Practical steps without an official rule: no source carries these topics,
  // so their evidence is the coordinator notes only. (A university page that
  // merely mentions a phone or a bank made the model drift into other subjects.)
  phone: ["phone"],
  insurance: ["insurance"],
  // Hour limits for students sit on study-stay (registration) and university (general) pages.
  work: ["work", "registration", "general"],
  bank: ["bank"],
  payroll: ["tax", "social-insurance"],
  "household-fee": ["household-fee"],
  "permit-renewal": ["registration", "visa"],
  departure: ["departure", "registration", "general"],
};

const answer = (profile: Profile, key: string) =>
  typeof profile[key] === "string" ? (profile[key] as string) : "";

const EHIC = "European Health Insurance Card (EHIC)";

/** "2026-08-24" -> "24 Aug 2026"; anything else -> "". */
export function formatDate(iso: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00Z`) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Build the ordered list of steps. EU/EFTA and non-EU students differ in
 * structure: non-EU students apply for a permit before travelling, use a
 * different registration form, and the EHIC doesn't apply to them.
 */
export function planSteps(profile: Profile, audience: "eu" | "non-eu"): PlanStep[] {
  const degree = answer(profile, "degree");
  const municipality = answer(profile, "municipality");
  const housing = answer(profile, "housingStatus");
  const work = answer(profile, "plansToWork");
  const coverage = answer(profile, "healthCoverage");
  const stay = answer(profile, "stayLength");
  const university = answer(profile, "university");

  const nonEu = audience === "non-eu";
  const group = nonEu ? "non-EU/EFTA" : "EU/EFTA";
  const isExchange = degree === "Exchange semester";
  const inCityOfBern = municipality === "City of Bern";
  const working = work === "Yes";
  const maybeWorking = work === "Yes" || work === "Not sure yet";
  // The EHIC only covers EU/EFTA citizens, so for non-EU students it isn't home cover.
  const hasHomeCover = nonEu
    ? coverage === "Private international insurance"
    : coverage !== "" && coverage !== "None / not sure";
  const homeCover = nonEu ? "their private insurance from home" : "home cover such as an EHIC";
  const shortStay = stay === "Up to 3 months";
  const longStay = stay === "Longer than a year";
  const arrival = formatDate(answer(profile, "arrival"));

  const steps: PlanStep[] = [];

  // 1. Housing comes first: the permit application and registration need an address.
  if (housing !== "Already arranged") {
    steps.push({
      id: "housing",
      phase: "Before you arrive",
      title: "Find accommodation",
      query: "finding accommodation, a room or flat as a student in Bern",
      topics: STEP_TOPICS.housing,
      brief: nonEu
        ? "Students arrange housing themselves. Explain what proof of housing the permit application and registration need, so they start early."
        : "Students arrange housing themselves; a confirmed address is needed before registering, so start early.",
      fallbackWhy: nonEu
        ? "You need proof of housing for your permit application and to register."
        : "You need a Swiss address before you can register with your municipality.",
      // The BFH page lists BFH's partner housing platforms.
      formId: university === "Bern University of Applied Sciences" ? "bfh-housing" : undefined,
      reason: "You told us you're still looking for a place to live.",
      time: "A few weeks",
    });
  }

  // 2. Non-EU students apply for their permit (and visa, if their nationality
  // needs one) before they travel.
  if (nonEu) {
    steps.push({
      id: "permit",
      phase: "Before you arrive",
      title: "Apply for your visa and residence permit",
      query:
        "non-EU student applying for a visa and residence permit for studies at the Swiss representation abroad before entry: documents and processing time",
      topics: STEP_TOPICS.permit,
      brief:
        "The student is not an EU/EFTA citizen, so they must apply before travelling. Explain where and how to apply, which documents are needed, how long it takes, and what changes if they already hold a Schengen residence permit or D visa. Whether their nationality needs a visa comes only from the evidence; if it doesn't say, tell them to check with the Swiss representation.",
      fallbackWhy: "As a non-EU student you need a permit for your studies before you travel to Switzerland.",
      formId: "eda-representations",
      reason: `You are not an EU/EFTA citizen, so your permit has to be arranged before you travel${arrival ? ` (you plan to arrive on ${arrival})` : ""}.`,
      time: "Several weeks to a few months",
    });
  }

  // 3. Registration with the municipality after arrival.
  const registrationForm = !inCityOfBern
    ? undefined
    : nonEu
      ? "bern-thirdcountry-registration"
      : isExchange
        ? "bern-exchange-registration"
        : "bern-eu-student-registration";
  steps.push({
    id: "registration",
    phase: "First two weeks",
    title: inCityOfBern ? "Register with the City of Bern" : "Register with your municipality",
    query: `registering with the municipality after arrival as a ${group} student, residence permit`,
    topics: STEP_TOPICS.registration,
    brief: [
      inCityOfBern
        ? nonEu
          ? "After arriving, send the City of Bern's registration form for non-EU/EFTA nationals with the required documents; explain what happens next."
          : `Register using the City of Bern's online form for ${isExchange ? "exchange" : "degree"} students; this also starts the residence permit.`
        : municipality === "Not sure yet"
          ? "Register with the municipality where you end up living; it isn't known yet, so don't name one."
          : "Register with the municipality in the canton of Bern where you live (not the City of Bern).",
      shortStay &&
        "The student has a short stay: explain whether and how the evidence says short stays must register; if it doesn't say, tell them to check with the municipality.",
    ]
      .filter(Boolean)
      .join(" "),
    fallbackWhy: "Registering where you live after arriving is required.",
    formId: registrationForm,
    reason: inCityOfBern
      ? `You'll live in the City of Bern as ${nonEu ? "a non-EU/EFTA student" : isExchange ? "an EU/EFTA exchange student" : "an EU/EFTA degree student"}, so this is the City's registration route for you.`
      : municipality === "Not sure yet"
        ? "You don't know yet where you'll live; you register with whichever municipality that turns out to be."
        : "You'll live outside the City of Bern, so you register with your own municipality.",
    time: "About 1 hour",
    deadlineFacts: ["registration-deadline"],
    deadlineFrom: "arrival",
  });

  // 4. A Swiss number helps with registration, landlords, the university and banks.
  steps.push({
    id: "phone",
    phase: "First two weeks",
    title: "Get a Swiss phone number",
    query: "getting a Swiss phone number or prepaid SIM card as a student",
    topics: STEP_TOPICS.phone,
    brief: "Explain why a local number helps and the simplest way to get one for this stay.",
    fallbackWhy: "A Swiss number makes registrations, landlords and banking easier.",
    reason: "Every student needs to be reachable: offices, landlords and banks ask for a Swiss number.",
    time: "30 minutes",
  });

  // 5. Health insurance. Working in Switzerland makes Swiss basic insurance
  // compulsory (federal health insurance law), so working, like having no home
  // cover, rules out the exemption. Deadlines come from the sources.
  if (!hasHomeCover) {
    steps.push({
      id: "insurance",
      phase: "First three months",
      title: "Get Swiss health insurance",
      query: "compulsory Swiss basic health insurance for students who are not insured at home",
      topics: STEP_TOPICS.insurance,
      brief: `The student has no home cover${nonEu ? " that counts (the EHIC is only for EU/EFTA citizens)" : ""} or isn't sure, so they can't count on an exemption. Explain that they need Swiss basic health insurance (or must first confirm their home cover), the deadline for taking it out, and what happens if they miss it.`,
      fallbackWhy: "Health insurance is compulsory for people living in Switzerland.",
      reason: nonEu && coverage === EHIC
        ? "You chose the EHIC, but it only covers EU/EFTA citizens, so it can't replace Swiss insurance for you."
        : "You told us you have no health cover from home, or aren't sure.",
      time: "1–2 hours",
      deadlineFacts: ["insurance-deadline"],
      deadlineFrom: "arrival",
    });
  } else if (working) {
    steps.push({
      id: "insurance",
      phase: "First three months",
      title: "Take out Swiss health insurance",
      query: "compulsory Swiss basic health insurance when taking up work in Switzerland",
      topics: STEP_TOPICS.insurance,
      brief: `The student will work in Switzerland, which makes Swiss basic health insurance compulsory even with ${homeCover}, so they cannot be exempted. Explain the deadline for taking it out, from when it applies, and what happens if they miss it. Never say they are exempt.`,
      fallbackWhy: "Working in Switzerland makes Swiss basic health insurance compulsory.",
      reason: "You plan to work in Switzerland, and a job ends the option of staying on your home insurance.",
      time: "1–2 hours",
      // Counted from the start of the job, which isn't known: no date.
      deadlineFacts: ["insurance-deadline"],
      deadlineFrom: "job-start",
    });
  } else if (maybeWorking) {
    steps.push({
      id: "insurance",
      phase: "First three months",
      title: "Apply for health insurance exemption",
      query: "exemption from Swiss compulsory health insurance for students, and what changes when taking up work",
      topics: STEP_TOPICS.insurance,
      brief: `The student has ${homeCover} but may work. Explain both cases: while not working they can apply for the exemption${nonEu ? " if their insurance meets the conditions in the evidence" : ""}; if they take a job, Swiss basic health insurance becomes compulsory, with the deadline for taking it out and what happens if they miss it.`,
      fallbackWhy: "You can stay on your home insurance only while you don't work in Switzerland.",
      formId: "asv-form-a",
      reason: "You have cover from home but may take a job, and a job would change which insurance you need.",
      time: "1–2 hours",
      deadlineFacts: ["exemption-deadline"],
      deadlineFrom: "arrival",
    });
  } else {
    steps.push({
      id: "insurance",
      phase: "First three months",
      title: "Apply for health insurance exemption",
      query: "exemption from Swiss compulsory health insurance for students insured in their home country",
      topics: STEP_TOPICS.insurance,
      brief: `The student has ${homeCover} and won't work, so they can normally apply to the cantonal office for exemption from Swiss compulsory health insurance.${nonEu ? " Explain the conditions their insurance must meet (per the evidence)." : ""} Explain the deadline for applying.`,
      fallbackWhy: "Without an exemption you would have to take out Swiss health insurance.",
      formId: "asv-form-a",
      reason: "You have health cover from home and don't plan to work, so you can ask to keep it.",
      time: "1–2 hours",
      deadlineFacts: ["exemption-deadline"],
      deadlineFrom: "arrival",
    });
  }

  // 6–7. Work and a bank account only matter if the student will work.
  if (maybeWorking) {
    steps.push({
      id: "work",
      phase: "Before you start a job",
      title: "Check the rules for working",
      query: nonEu
        ? "foreign students from non-EU countries working part-time while studying: months after the start of the course, hours per week, employer application and cantonal approval"
        : "can I work during my studies as an EU/EFTA student: hours per week during the semester and in the holidays",
      topics: STEP_TOPICS.work,
      brief: nonEu
        ? "The student is not an EU/EFTA citizen. Explain from when after the start of their studies they may work, the weekly hour limit during the semester, what conditions apply to working more during semester breaks, and the approvals needed before starting (university, employer's application, cantonal authority). Compare that waiting period with their length of stay, and say plainly if they likely can't work during it. Never say they can start right away. Starting a job makes Swiss basic health insurance compulsory (see the insurance step)."
        : "Explain how many hours a week EU/EFTA students may work during the semester and during semester breaks, and what to check before taking up a job. Starting a job makes Swiss basic health insurance compulsory (see the insurance step).",
      fallbackWhy: nonEu
        ? "As a non-EU student you need approval before you take a job, and limits apply."
        : "There are limits on how much you may work while studying; check them before taking a job.",
      // Non-EU: the employer's application to the canton, wherever they live.
      formId: nonEu ? "awi-job-start" : inCityOfBern ? "bern-work-permits" : undefined,
      reason: working
        ? "You told us you plan to work in Switzerland."
        : "You told us you might work in Switzerland.",
      time: "1–2 hours",
      // The waiting period is compared with how long the student stays.
      uses: nonEu ? ["stayLength"] : undefined,
    });
  }
  if (working) {
    steps.push({
      id: "bank",
      phase: "Settling in",
      title: "Open a Swiss bank account",
      query: "opening a Swiss bank account as a student and receiving a salary",
      topics: STEP_TOPICS.bank,
      brief: "Explain when a Swiss account is needed and what opening one involves.",
      fallbackWhy: "You'll need a Swiss account to receive your salary.",
      reason: "You plan to work, and a Swiss salary is paid into a Swiss account.",
      time: "About 1 hour",
    });
    // What comes off a Swiss salary. The figures come from the AHV/IV leaflets
    // and the tax administrations, never from here.
    steps.push({
      id: "payroll",
      phase: "Settling in",
      title: "Understand your payslip deductions",
      query:
        "deductions from a student's salary in Switzerland: tax at source (Quellensteuer) for foreign employees and AHV/IV/EO contributions",
      topics: STEP_TOPICS.payroll,
      brief:
        "Explain what is taken off a foreign student's Swiss salary before it is paid out: tax at source for foreign employees without a settlement permit, and social insurance contributions (AHV/IV/EO). Say that the employer deducts them, and that the student should check their payslip. Give a rate or amount only if the evidence states it.",
      fallbackWhy:
        "Your employer deducts tax at source and social insurance contributions from your salary; check them on your payslip.",
      reason: "You plan to work, so tax at source and social insurance will come off your salary.",
      time: "30 minutes",
    });
  }

  // The radio and TV fee is charged per household, whoever lives in it.
  steps.push({
    id: "household-fee",
    phase: "Settling in",
    title: "Know about the radio and TV fee (Serafe)",
    query:
      "radio and television fee per household collected by Serafe: who pays, private households and collective households such as student hostels",
    topics: STEP_TOPICS["household-fee"],
    brief:
      "Explain that Switzerland charges a radio and television fee per household, collected by Serafe, and that the bill arrives without registering. Explain the difference the evidence makes between a private household (one bill for the whole flat, to be shared) and a collective household such as a student hostel (the residents pay nothing themselves). Give the amount only if the evidence states it.",
    fallbackWhy:
      "Every Swiss household is billed a radio and TV fee; in a shared flat it is one bill for everyone.",
    reason:
      housing === "Already arranged"
        ? "You have a place to live, and the fee depends on what kind of household it is."
        : "Whichever place you find, the fee depends on what kind of household it is.",
    time: "15 minutes",
  });

  // Students who stay for years renew their permit; everyone else leaves first.
  if (longStay) {
    steps.push({
      id: "permit-renewal",
      phase: "Each year",
      title: "Renew your residence permit",
      query:
        "extending or renewing a residence permit (Aufenthaltsbewilligung verlängern): when the notice arrives and where to hand it in",
      topics: STEP_TOPICS["permit-renewal"],
      brief:
        "The student stays longer than a year. Explain how renewing the residence permit works according to the evidence: what notice they receive and when, and where and with which documents they hand it in. Don't state how long a permit is valid unless the evidence says so for students.",
      fallbackWhy: "A residence permit is issued for a limited time and has to be renewed before it runs out.",
      reason: "You're staying longer than a year, so your permit will need renewing while you're here.",
      time: "About 1 hour",
    });
  } else {
    steps.push({
      id: "departure",
      phase: "Before you leave",
      title: inCityOfBern ? "Deregister with the City of Bern" : "Deregister with your municipality",
      query:
        "deregistering with the municipality when moving abroad at the end of the stay (Abmeldung, Wegzug ins Ausland): when, how, and returning the residence permit",
      topics: STEP_TOPICS.departure,
      brief: `When the stay ends, the student must deregister with ${inCityOfBern ? "the City of Bern" : "their municipality"} before leaving Switzerland. Explain how and how early the evidence says this can be done, and what happens to the residence permit card. A rule the evidence gives for the City of Bern applies only to students living there.`,
      fallbackWhy: "Before leaving Switzerland you have to deregister with the municipality where you live.",
      formId: inCityOfBern ? "bern-departure-abroad" : undefined,
      reason: `Your stay is ${stay ? stay.toLowerCase().replace(/\s*\(.*\)/, "") : "temporary"}, so you'll be leaving Switzerland again.`,
      time: "30 minutes",
    });
  }


  return steps;
}
