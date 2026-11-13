// Retrieval check: for questions students really ask, does the search put a
// source that holds the answer in the top 3? Run it before and after changing
// anything about search (chunking, embedding model, keyword weight, sources):
//
//   npm run eval:retrieval
//   RETRIEVAL_LEXICAL_WEIGHT=0 npm run eval:retrieval    (meaning-based search only)
//
// It needs Ollama (for the query embeddings) but not the backend.
// `expect` lists every source that plausibly holds the answer. Have a
// coordinator extend the list with questions students actually asked.

import { retrieve } from "../src/knowledge.js";
import { db } from "../src/db.js";

type Case = { q: string; status: "EU / EFTA" | "Non-EU / EFTA"; expect: string[] };

const EU = "EU / EFTA";
const NON_EU = "Non-EU / EFTA";

const CASES: Case[] = [
  { q: "How many hours a week can I work during the semester?", status: EU, expect: ["bern-education-stay", "coordinator-eu-exchange", "bfh-foreign-students", "bfh-student-guide", "bfh-student-guide-web", "unibe-financial-matters"] },
  { q: "When can I start a part-time job after my studies begin?", status: NON_EU, expect: ["sem-work-faq", "bfh-foreign-students", "bfh-student-guide", "bfh-student-guide-web", "unibe-financial-matters", "bern-education-stay"] },
  { q: "What is the deadline to apply for an exemption from compulsory health insurance?", status: EU, expect: ["asv-exemption-info", "asv-form-a", "bag-students", "bfh-health-factsheet", "bfh-insurance", "unibe-health-insurance"] },
  { q: "Within how many days do I have to register after I arrive?", status: EU, expect: ["bern-education-stay", "migration-be-permit-b", "migration-be-permit-l", "bfh-foreign-students", "sem-euefta-faq", "bern-new-in-bern", "unibe-entry-residence", "bfh-student-guide"] },
  { q: "Where do I apply for my student visa?", status: NON_EU, expect: ["migration-be-third-country", "sem-entry-faq", "eda-visa-requirements", "sem-entry-with-visa", "sem-visa-application-form", "unibe-entry-residence", "bfh-foreign-students"] },
  { q: "What happens if I take out Swiss health insurance too late?", status: EU, expect: ["bag-residents", "asv-basic-insurance", "asv-compulsory-brochure", "bag-premium-faq", "bag-insurance-requirement", "coordinator-eu-exchange"] },
  { q: "How do I find a room in Bern?", status: EU, expect: ["bfh-housing", "bfh-student-guide", "bfh-student-guide-web", "unibe-accommodation", "bfh-business-mobility"] },
  { q: "What is deducted from my salary for AHV?", status: EU, expect: ["ahv-salary-contributions", "ahv-social-security-overview", "ahv-student-contributions"] },
  { q: "Do I pay tax at source on my wages?", status: NON_EU, expect: ["estv-tax-at-source", "be-tax-at-source-who", "be-taxinfo-tax-at-source-employees", "bern-city-work-tax"] },
  { q: "How do I get an AHV number?", status: EU, expect: ["zas-ahv-number", "zas-ahv-number-faq"] },
  { q: "Can I get a reduction on my health insurance premium?", status: EU, expect: ["asv-premium-reduction-faq", "bag-premium-subsidies"] },
  { q: "Do I have to deregister when I leave Switzerland at the end of my exchange?", status: EU, expect: ["bfh-foreign-students", "migration-be-permit-b", "bern-moving-overview", "bern-departure-abroad-form", "bfh-student-guide"] },
  { q: "Is my European Health Insurance Card enough as an exchange student?", status: EU, expect: ["bag-students", "bfh-health-factsheet", "bfh-insurance", "asv-form-a", "asv-exemption-info", "unibe-health-insurance"] },
  { q: "How much does the residence permit cost?", status: EU, expect: ["bfh-foreign-students", "bfh-student-guide", "bern-education-stay", "migration-be-permit-b"] },
  { q: "Am I insured against accidents at my student job?", status: EU, expect: ["suva-who-is-insured", "ahv-social-security-overview", "bfh-insurance", "bfh-foreign-students"] },
  { q: "How do I renew my residence permit?", status: EU, expect: ["migration-be-permit-b", "sem-permit-b-euefta"] },
  { q: "What does my employer have to do before I can start working?", status: NON_EU, expect: ["weu-hiring-third-country", "sem-work-faq", "bern-work-permits", "bfh-foreign-students", "unibe-financial-matters"] },
  { q: "Do I need personal liability insurance?", status: EU, expect: ["bfh-foreign-students", "bfh-insurance", "bfh-student-guide", "bfh-student-guide-web"] },
  { q: "Which documents do I need to register with the City of Bern as an exchange student?", status: EU, expect: ["bern-education-stay", "bfh-foreign-students", "bern-new-in-bern", "unibe-entry-residence"] },
  { q: "How much money do I have to prove I have for the residence permit?", status: NON_EU, expect: ["sem-nonworking-factsheet", "bfh-foreign-students", "migration-be-third-country", "unibe-financial-matters", "bfh-student-guide", "unibe-entry-residence"] },
  { q: "Do I have to pay the Serafe radio and TV fee in a student residence?", status: EU, expect: ["bakom-fee-collective-households", "bakom-fee-private-households"] },
  { q: "Do I need a visa to enter Switzerland with a US passport?", status: NON_EU, expect: ["sem-entry-without-visa", "eda-visa-requirements", "sem-entry-faq", "sem-entry-with-visa"] },
];

const sourceOf = db.prepare("SELECT source_id FROM kb_chunks WHERE url = ? LIMIT 1");
let hits = 0;
let reciprocal = 0;
let precise = 0;

for (const c of CASES) {
  const top = await retrieve(c.q, { status: c.status, k: 3 });
  const ids = top.map((t) => (sourceOf.get(t.url) as { source_id: string } | undefined)?.source_id ?? "?");
  const rank = ids.findIndex((id) => c.expect.includes(id));
  if (rank >= 0) hits++;
  reciprocal += rank >= 0 ? 1 / (rank + 1) : 0;
  precise += ids.filter((id) => c.expect.includes(id)).length / 3;
  console.log(`${rank >= 0 ? "ok  " : "MISS"} ${c.q}\n       ${ids.join(", ")}`);
}

const n = CASES.length;
console.log(
  `\n${hits}/${n} questions have a right source in the top 3 ` +
    `(mean reciprocal rank ${(reciprocal / n).toFixed(2)}, ` +
    `${Math.round((100 * precise) / n)}% of the top-3 passages from a right source)`,
);
