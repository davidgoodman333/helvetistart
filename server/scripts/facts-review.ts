// Review the key facts extracted from the official sources. Only APPROVED
// facts are used in plans and chat answers, so nothing reaches a student until
// a person has compared each value with its quote.
//
//   npm run facts                       list every fact with its quote and source
//   npm run facts -- approve <id> ...   approve facts (or "approve all-pending")
//   npm run facts -- reject <id> ...    reject facts
//
// Works on the database directly; the backend doesn't need to be running. If
// it is running, restart it afterwards (or approve through POST
// /api/kb/facts/<id>/approve) so stored plan steps are rewritten with the facts.

import { loadFacts, reviewFact } from "../src/facts.js";

const [action, ...ids] = process.argv.slice(2);
const facts = loadFacts(null, { approvedOnly: false });

if (action === "approve" || action === "reject") {
  const targets = ids.includes("all-pending")
    ? facts.filter((f) => f.status === "pending").map((f) => f.id)
    : ids;
  if (targets.length === 0) console.log("Nothing to do: name at least one fact id.");
  for (const id of targets) {
    const ok = reviewFact(id, action === "approve" ? "approved" : "rejected");
    console.log(`${ok ? (action === "approve" ? "approved" : "rejected") : "NOT FOUND"}  ${id}`);
  }
} else {
  for (const f of facts) {
    console.log(`\n${f.status.toUpperCase().padEnd(9)} ${f.id}   (${f.audience}, ${f.topic})`);
    console.log(`  asks:   ${f.question}`);
    console.log(`  value:  ${f.value}`);
    console.log(`  quote:  "${f.quote}"`);
    console.log(`  source: ${f.title}\n          ${f.url}`);
    if (f.previousValue) console.log(`  was:    ${f.previousValue} (changed ${f.changedAt})`);
  }
  const count = (status: string) => facts.filter((f) => f.status === status).length;
  console.log(
    `\n${facts.length} facts: ${count("approved")} approved, ${count("pending")} pending, ${count("rejected")} rejected.` +
      (count("pending") ? "\nPending facts are NOT used. Compare each value with its quote, then: npm run facts -- approve <id>" : ""),
  );
}
