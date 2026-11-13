import express from "express";
import cors from "cors";
import { db } from "./db.js";
import { chat, ChatMessage, chatTurn, llmAvailable, LLM_MODEL, stripThinking, warmUp } from "./llm.js";
import {
  audienceFor,
  chunkKey,
  ingestAll,
  institutionFor,
  kbStatus,
  recentSourceChanges,
  retrieve,
  RetrievedChunk,
} from "./knowledge.js";
import { FORMS, verifyForms } from "./forms.js";
import { classifyCitizenship, withServerStatus } from "./citizenship.js";
import { planSteps, PlanStep, STEP_TOPICS } from "./plan-rules.js";
import { numbersSupported } from "./grounding.js";
import {
  buildContext,
  buildPlan,
  factChunk,
  PlanEvent,
  prewarmPlans,
  sourceList,
  summarizeProfile,
} from "./plan.js";
import { runTool, TOOL_SPECS } from "./tools.js";
import { ensureFacts, extractFacts, Fact, loadFacts, relevantFacts, reviewFact } from "./facts.js";
import {
  addDocument,
  deleteDocument,
  DocumentChunk,
  documentOverview,
  getDocument,
  listDocuments,
  MAX_UPLOAD_BYTES,
  retrieveDocumentChunks,
} from "./documents.js";

const app = express();
const PORT = Number(process.env.API_PORT || 3001);

app.use(cors()); // allow the frontend (localhost:5173) to call this API
app.use(express.json()); // parse JSON request bodies

// A task as stored in the DB, before we parse the documents JSON.
type TaskRow = {
  id: number;
  phase: string;
  title: string;
  description: string;
  deadline: string;
  time: string;
  source: string;
  source_url: string;
  documents: string;
  email_to: string | null;
};

// Turn a DB row into the shape the frontend expects (documents as an array).
function serializeTask(row: TaskRow) {
  return {
    id: row.id,
    phase: row.phase,
    title: row.title,
    description: row.description,
    deadline: row.deadline,
    time: row.time,
    source: row.source,
    sourceUrl: row.source_url,
    documents: JSON.parse(row.documents) as string[],
    emailTo: row.email_to ?? undefined,
  };
}

// Which citizenship groups get a generated plan (PLAN_AUDIENCES=eu turns
// non-EU plans off again, e.g. while their rules are being reviewed).
const PLAN_AUDIENCES = new Set(
  (process.env.PLAN_AUDIENCES ?? "eu,non-eu").split(",").map((s) => s.trim()),
);

// Chat answers are checked sentence by sentence: a sentence whose
// number isn't in the context or the student's answers is removed, because the
// model filled it in from memory (e.g. another country's hour limit).
// Citation markers like [3] are not facts and are ignored.
function dropUnsupportedNumbers(answer: string, sourceText: string): string {
  let dropped = false;
  const kept = answer.split("\n").flatMap((line) => {
    // A bullet or numbered-list marker is formatting, not a fact: keep it aside.
    const [, marker = "", body = line] = line.match(/^(\s*(?:[-*•]|\d+[.)])\s+)(.*)$/) ?? [];
    const sentences = body.trim().split(/(?<=[.!?])\s+/).filter(Boolean).filter((sentence) => {
      const ok = numbersSupported(sentence.replace(/\[\d+(?:\s*,\s*\d+)*\]/g, ""), sourceText);
      if (!ok) dropped = true;
      return ok;
    });
    if (sentences.length === 0) return body.trim() ? [] : [line]; // the whole line went
    return [marker + sentences.join(" ")];
  });
  if (!dropped) return answer;
  return `${kept.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n\nI left out a figure I couldn't find in the official sources — check the source for exact numbers.`;
}

// A passage of a document the student uploaded, as a context item. Its url is
// not a web link, so the UI shows it without one.
const documentChunk = (d: DocumentChunk): RetrievedChunk => ({
  text: d.text,
  title: `Your document: ${d.filename}`,
  url: `upload:${d.documentId}`,
  topic: "student-document",
  authority: "student",
  score: d.score,
});

// --- Health check -----------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// --- Warm-up: load the models while the student fills in onboarding ---------
// Answers right away; the loading happens in the background.
app.post("/api/warmup", async (_req, res) => {
  res.status(202).json({ ok: true });
  if (await llmAvailable()) {
    warmUp()
      // While the student fills in onboarding, write any plan step that isn't stored yet.
      .then(() => prewarmPlans())
      .catch((err) => console.warn(`Warm-up failed: ${(err as Error).message}`));
  }
});

// --- Auth: sign in with email (creates the user on first sign-in) -----------
// No password yet, by design — we add that in a later step.
app.post("/api/login", (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "A valid email is required." });
  }

  let user = db.prepare("SELECT id, email FROM users WHERE email = ?").get(email) as
    | { id: number; email: string }
    | undefined;

  if (!user) {
    const info = db.prepare("INSERT INTO users (email) VALUES (?)").run(email);
    const id = Number(info.lastInsertRowid);
    // create an empty profile row so later reads always find something
    db.prepare("INSERT INTO profiles (user_id, email) VALUES (?, ?)").run(id, email);
    user = { id, email };
  }

  res.json({ user });
});

// --- Profile: read ----------------------------------------------------------
app.get("/api/profile/:userId", (req, res) => {
  const userId = Number(req.params.userId);
  const profile = db
    .prepare(
      `SELECT email, first_name AS firstName, nationality, age, status,
              university, degree, canton, arrival,
              plans_to_work AS plansToWork, stay_length AS stayLength,
              municipality, housing_status AS housingStatus,
              health_coverage AS healthCoverage
         FROM profiles WHERE user_id = ?`,
    )
    .get(userId) as Record<string, unknown> | undefined;

  if (!profile) return res.status(404).json({ error: "Profile not found." });
  // Recompute so profiles saved before a classifier fix come back corrected.
  const nationality = typeof profile.nationality === "string" ? profile.nationality : "";
  res.json({
    profile: withServerStatus(profile),
    citizenship: classifyCitizenship(nationality),
  });
});

// --- Citizenship: classify what the student typed (single source of truth) ---
app.post("/api/citizenship/classify", (req, res) => {
  res.json(classifyCitizenship(String(req.body?.nationality ?? "")));
});

// --- Profile: create/update (upsert) ----------------------------------------
app.put("/api/profile/:userId", (req, res) => {
  const userId = Number(req.params.userId);
  const exists = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!exists) return res.status(404).json({ error: "User not found." });

  const b = req.body ?? {};
  db.prepare(
    `INSERT INTO profiles
       (user_id, email, first_name, nationality, age, status, university, degree, canton, arrival,
        plans_to_work, stay_length, municipality, housing_status, health_coverage, updated_at)
     VALUES
       (@user_id, @email, @first_name, @nationality, @age, @status, @university, @degree, @canton, @arrival,
        @plans_to_work, @stay_length, @municipality, @housing_status, @health_coverage, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       email=excluded.email, first_name=excluded.first_name, nationality=excluded.nationality,
       age=excluded.age, status=excluded.status, university=excluded.university,
       degree=excluded.degree, canton=excluded.canton, arrival=excluded.arrival,
       plans_to_work=excluded.plans_to_work, stay_length=excluded.stay_length,
       municipality=excluded.municipality, housing_status=excluded.housing_status,
       health_coverage=excluded.health_coverage,
       updated_at=datetime('now')`,
  ).run({
    user_id: userId,
    email: String(b.email ?? ""),
    first_name: String(b.firstName ?? ""),
    nationality: String(b.nationality ?? ""),
    age: String(b.age ?? ""),
    status: String(withServerStatus(b).status ?? ""),
    university: String(b.university ?? ""),
    degree: String(b.degree ?? ""),
    canton: String(b.canton ?? ""),
    arrival: String(b.arrival ?? ""),
    plans_to_work: String(b.plansToWork ?? ""),
    stay_length: String(b.stayLength ?? ""),
    municipality: String(b.municipality ?? ""),
    housing_status: String(b.housingStatus ?? ""),
    health_coverage: String(b.healthCoverage ?? ""),
  });

  res.json({ ok: true });
});

// --- Tasks: list the seeded relocation tasks --------------------------------
app.get("/api/tasks", (_req, res) => {
  const rows = db.prepare("SELECT * FROM tasks ORDER BY id").all() as TaskRow[];
  res.json({ tasks: rows.map(serializeTask) });
});

// --- Progress: read the list of completed task ids --------------------------
app.get("/api/progress/:userId", (req, res) => {
  const userId = Number(req.params.userId);
  const rows = db
    .prepare("SELECT task_id FROM progress WHERE user_id = ? ORDER BY task_id")
    .all(userId) as { task_id: number }[];
  res.json({ completed: rows.map((r) => r.task_id) });
});

// --- Progress: replace the full set of completed task ids -------------------
app.put("/api/progress/:userId", (req, res) => {
  const userId = Number(req.params.userId);
  const exists = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!exists) return res.status(404).json({ error: "User not found." });

  const completed: number[] = Array.isArray(req.body?.completed)
    ? req.body.completed.map((n: unknown) => Number(n)).filter((n: number) => Number.isInteger(n))
    : [];

  const replace = db.transaction((ids: number[]) => {
    db.prepare("DELETE FROM progress WHERE user_id = ?").run(userId);
    const insert = db.prepare("INSERT OR IGNORE INTO progress (user_id, task_id) VALUES (?, ?)");
    for (const id of ids) insert.run(userId, id);
  });
  replace(completed);

  res.json({ ok: true, completed });
});

// --- Knowledge base: build / status -----------------------------------------
// Which plan steps draw evidence from a source. Coordinator notes feed them all.
function stepsUsing(src: { id: string; topic: string }): string[] {
  const coordinator = src.id.startsWith("coordinator-");
  return Object.entries(STEP_TOPICS)
    .filter(([, topics]) => coordinator || topics.some((t) => t === src.topic))
    .map(([id]) => id);
}

// Fetches the official sources (through the allow-list) and embeds them locally.
app.post("/api/ingest", async (_req, res) => {
  if (!(await llmAvailable())) {
    return res.status(503).json({ error: "Local model not reachable (needed for embeddings)." });
  }
  try {
    const summary = await ingestAll();
    const forms = await verifyForms();
    // A changed source can change what its plan steps should say: list them so
    // a coordinator can check the new text (and the rules, if the law changed).
    const changed = summary.changed.map((src) => ({ ...src, affectsSteps: stepsUsing(src) }));
    if (changed.length) {
      console.warn(`Sources changed since last ingest: ${changed.map((c) => c.id).join(", ")}`);
    }
    // Key facts are re-extracted from the fresh sources; a changed figure is
    // reported for review ("6 months -> 3 months").
    const facts = await extractFacts();
    if (facts.changed.length) {
      console.warn(`Key facts changed: ${facts.changed.map((c) => `${c.id}: ${c.from} -> ${c.to}`).join("; ")}`);
    }
    res.json({ ...summary, changed, forms, facts });
    // New source text means new evidence: write the plan steps for it now, in
    // the background, rather than while the next student waits.
    void prewarmPlans();
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/kb/status", (_req, res) => {
  res.json(kbStatus());
});

// The key facts extracted from the official sources, with their quotes and
// review status. Only approved facts are used in answers and plans.
app.get("/api/kb/facts", (_req, res) => {
  res.json({ facts: loadFacts(null, { approvedOnly: false }) });
});

// Review an extracted fact. NOTE: like the rest of this API there is no login
// yet; these must be restricted to coordinators before the app is hosted.
app.post("/api/kb/facts/:id/:decision(approve|reject)", (req, res) => {
  const status = req.params.decision === "approve" ? "approved" : "rejected";
  if (!reviewFact(req.params.id, status)) return res.status(404).json({ error: "Fact not found." });
  res.json({ ok: true, id: req.params.id, status });
  // An approved fact is added to its steps' prompts, so they are written again.
  void prewarmPlans();
});

// Sources whose text changed at recent ingests, with the plan steps they feed.
app.get("/api/kb/changes", (_req, res) => {
  res.json({
    changes: recentSourceChanges().map((src) => ({ ...src, affectsSteps: stepsUsing(src) })),
  });
});

// The curated form catalogue (read-only, for transparency).
app.get("/api/forms", (_req, res) => {
  res.json({ forms: FORMS });
});

// --- Chat tools -----------------------------------------------------------------
// The chat model may call the tools in tools.ts (CHAT_TOOLS=false turns that
// off). At most this many rounds of tool calls per question, so an answer never
// takes more than a few model turns.
const CHAT_TOOLS = process.env.CHAT_TOOLS !== "false";
const CHAT_TOOL_ROUNDS = 2;
// When to reach for which tool. This goes right after the question: placed
// among the many rules of the system prompt, the model never used a tool.
const TOOL_HINTS = [
  "\n\nBefore answering, call a tool if one of these applies (otherwise answer from the CONTEXT):",
  "- The student wants a calendar date (\"by what date\", \"until when exactly\"): call calculate_deadline with their arrival date and the period from the CONTEXT. Never work a date out yourself.",
  "- The student asks where or how to apply, register or deregister, or for a form or link: call find_form.",
  "- The student asks about their plan, their steps or what to do next: call get_plan_steps.",
  "- The CONTEXT doesn't contain what is asked: call search_sources with a better query.",
].join("\n");

// A guardrail for one rule that must never come out wrong: a student who works
// needs Swiss basic health insurance, whatever other cover they hold. Asked
// "can I use my private insurance / EHIC when I work?", the model kept opening
// with "Yes, you can…" before listing the rule that says otherwise. When the
// question is about insurance while working and the answer opens with "Yes",
// the opening sentence is replaced with the rule's own verdict. (The rule is the
// same one plan-rules.ts applies to the insurance step.)
const WORKING_INSURANCE_VERDICT =
  "No. Once you work in Switzerland you need Swiss basic health insurance from a Swiss health insurer; an EHIC, a home insurance or an international student insurance is then not enough, and an exemption is no longer possible.";

function insuranceWhileWorking(answer: string, question: string): string {
  const aboutInsurance = /insur|ehic|swisscare|krankenkasse|kvg|exempt/i.test(question);
  if (!aboutInsurance || workSituation(question) !== "working") return answer;
  if (!/^\s*yes\b/i.test(answer)) return answer;
  // Drop the opening sentence (up to the first full stop or line break).
  const rest = answer.replace(/^\s*yes\b[^.\n]*[.\n]\s*/i, "");
  return `${WORKING_INSURANCE_VERDICT}\n${rest}`.trim();
}

// Does the question say whether the student works? "when I work", "if I get a
// job" -> working; "if I don't work", "without a job" -> not working; a
// question about working itself ("can I work…?") or one that doesn't say -> null.
function workSituation(question: string): "working" | "not-working" | null {
  const q = question.toLowerCase();
  if (/\b(do not|don't|dont|not|never|without|no)\s+(\w+\s+)?(work\w*|job|employ\w*)\b/.test(q)) {
    return "not-working";
  }
  if (/\b(when|if|while|once|as soon as|since|because)\s+i(\s+\w+){0,2}\s+(work\w*|job|employ\w*)\b/.test(q) || /\bi\s+(work|am working|have a job|got a job|found a job)\b/.test(q)) {
    return "working";
  }
  return null;
}

// --- Chat memory --------------------------------------------------------------
// How many earlier messages the assistant sees. Enough for follow-ups, small
// enough to leave room in the prompt for the sources.
const CHAT_MEMORY = 6;

type ChatTurn = { role: "user" | "ai"; text: string };

function chatHistory(userId: number, limit: number) {
  const rows = db
    .prepare(
      `SELECT role, text, sources, attachments FROM chat_messages
        WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(userId, limit) as { role: "user" | "ai"; text: string; sources: string; attachments: string }[];
  return rows.reverse().map((r) => ({
    role: r.role,
    text: r.text,
    sources: JSON.parse(r.sources),
    attachments: JSON.parse(r.attachments) as string[],
  }));
}

const userExists = (userId: number) =>
  Number.isInteger(userId) && !!db.prepare("SELECT id FROM users WHERE id = ?").get(userId);

// The saved conversation, for showing it again when the student comes back.
app.get("/api/chat/:userId", (req, res) => {
  res.json({ messages: chatHistory(Number(req.params.userId), 100) });
});

// Start over: forget the conversation.
app.delete("/api/chat/:userId", (req, res) => {
  db.prepare("DELETE FROM chat_messages WHERE user_id = ?").run(Number(req.params.userId));
  res.json({ ok: true });
});

// --- Documents the student uploads --------------------------------------------
// Files are read and summarised by the LOCAL models and stored only in the
// local database. NOTE: like the rest of this API there is no password yet, so
// anyone who knows a user id could read that user's documents; add auth before
// hosting the app anywhere other than this machine.
app.get("/api/documents/:userId", (req, res) => {
  const userId = Number(req.params.userId);
  if (!userExists(userId)) return res.status(404).json({ error: "User not found." });
  res.json({ documents: listDocuments(userId) });
});

app.get("/api/documents/:userId/:docId", (req, res) => {
  const doc = getDocument(Number(req.params.userId), Number(req.params.docId));
  if (!doc) return res.status(404).json({ error: "Document not found." });
  res.json({ document: doc });
});

// The file is the raw request body; its name comes in the X-Filename header.
app.post(
  "/api/documents/:userId",
  express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
  (req, res) => {
    const userId = Number(req.params.userId);
    if (!userExists(userId)) return res.status(404).json({ error: "Sign in to upload documents." });
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (bytes.length === 0) return res.status(400).json({ error: "The file is empty." });
    let filename = "document";
    try {
      filename = decodeURIComponent(String(req.get("X-Filename") ?? "document"));
    } catch {
      // keep the default name
    }
    filename = filename.split(/[\\/]/).pop()!.slice(0, 200) || "document";
    const mime = String(req.get("Content-Type") ?? "application/octet-stream").split(";")[0].trim();
    try {
      res.status(202).json({ document: addDocument(userId, { filename, mime, bytes }) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

app.delete("/api/documents/:userId/:docId", (req, res) => {
  if (!deleteDocument(Number(req.params.userId), Number(req.params.docId))) {
    return res.status(404).json({ error: "Document not found." });
  }
  res.json({ ok: true });
});

// --- AI assistant (chat): grounded in official sources only ------------------
app.post("/api/assistant", async (req, res) => {
  // The citizenship group is always recomputed here, never trusted from the browser.
  const profile = withServerStatus(req.body?.profile ?? {});
  const question = String(req.body?.question ?? "").trim();
  if (!question) return res.status(400).json({ error: "A question is required." });
  // The student can stop an answer: the app drops the request, which stops the
  // model too. A stopped question is not saved to the conversation.
  const stopped = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) stopped.abort();
  });
  // Earlier messages: from the saved conversation when signed in, otherwise
  // whatever the app sends along (never more than CHAT_MEMORY).
  const userId = Number(req.body?.userId);
  const signedIn = userExists(userId);
  const history: ChatTurn[] = signedIn
    ? chatHistory(userId, CHAT_MEMORY)
    : (Array.isArray(req.body?.history) ? req.body.history : [])
        .filter((m: ChatTurn) => (m?.role === "user" || m?.role === "ai") && typeof m.text === "string")
        .slice(-CHAT_MEMORY);
  if (!(await llmAvailable())) {
    return res.status(503).json({ error: "The local AI model isn't reachable. Start Ollama." });
  }

  // Adding the student's situation steers search toward rules for their group
  // (e.g. EU/EFTA students living in Bern) rather than any page on the topic.
  const status = String(profile.status ?? "");
  const situation = [status && `${status} student`, profile.degree, profile.municipality]
    .filter(Boolean)
    .join(", ");
  // A follow-up ("and how long do I have?") is searched together with the
  // previous question, so the search knows what it is about.
  const previousQuestion = [...history].reverse().find((m) => m.role === "user")?.text ?? "";
  // Documents the student attached to this very message (already read). The
  // question is about them, so what they are joins the search: "what do I do
  // with this?" alone finds nothing useful.
  const attachedIds: number[] = Array.isArray(req.body?.documentIds)
    ? req.body.documentIds.map(Number).filter(Number.isInteger)
    : [];
  const attached = signedIn
    ? listDocuments(userId).filter((d) => d.status === "ready" && attachedIds.includes(d.id))
    : [];
  const searchText = [
    previousQuestion,
    question,
    ...attached.map((d) => `${d.documentType} ${d.summary}`),
  ]
    .filter(Boolean)
    .join(" ");
  let chunks: RetrievedChunk[];
  try {
    chunks = await retrieve(situation ? `${searchText} (${situation})` : searchText, {
      status,
      k: 8,
      institution: institutionFor(profile.university),
    });
  } catch (err) {
    return res.status(502).json({ error: `Retrieval failed: ${(err as Error).message}` });
  }
  // Key facts this question (with the one before it, for follow-ups) is about.
  // Their quotes go first in the context, numbered [1], [2]..., so they can be cited.
  const audience = audienceFor(status);
  const allFacts = loadFacts(audience);
  let facts: Fact[] = [];
  try {
    facts = await relevantFacts(searchText, allFacts);
  } catch {
    // without facts the answer still comes from the sources
  }
  // The student's own uploaded documents, when the question may be about them.
  // They go last, so the key facts keep their numbers [1], [2]...
  const documents = signedIn ? documentOverview(userId) : "";
  let documentChunks: RetrievedChunk[] = [];
  if (documents) {
    try {
      // With attachments, the passages come from those documents only.
      documentChunks = (
        attached.length
          ? await retrieveDocumentChunks(userId, searchText, 6, attached.map((d) => d.id))
          : await retrieveDocumentChunks(userId, searchText, 4)
      ).map(documentChunk);
    } catch {
      // the answer can still come from the official sources
    }
  }
  chunks = [...facts.map(factChunk), ...chunks, ...documentChunks];
  if (chunks.length === 0) {
    return res.json({
      answer:
        "I don't have the official sources loaded yet, so I can't answer reliably. Build the knowledge base first (POST /api/ingest).",
      sources: [],
    });
  }

  const system = [
    "You are HelvetiStart, a Swiss student-relocation assistant.",
    "Answer ONLY using the CONTEXT below: OFFICIAL SOURCE items (rules, deadlines, documents), COORDINATOR GUIDANCE items (practical order and tips) and STUDENT'S OWN DOCUMENT items (files the student uploaded). If they disagree, the official source wins.",
    "STUDENT'S OWN DOCUMENT items are passages from the student's own files (e.g. their admission letter, rental agreement or insurance policy). Use them for facts about the student's own situation — their dates, addresses, amounts, conditions — and cite them like any other item. When the question is about one of their documents, answer from it: explain what it says in plain English, even if it is in German, and report its details exactly — e.g. a permit stated as \"Kurzaufenthalt L\" is a short-term L permit; never replace a detail from the document with a general description from these instructions. A document never decides a Swiss rule: for rules, deadlines and requirements the official sources win. If a document seems to conflict with an official rule, say so and point to the official source.",
    "If the answer is not in the context, say you don't have that detail and point to the most relevant listed source.",
    "NEVER invent URLs, office names, figures, or deadlines. Only cite URLs that appear in the context.",
    "Every number you give (hours, days, months, fees) must come from the CONTEXT, never from your own knowledge: rules change over time. If the CONTEXT doesn't state it, say you don't have that detail and point to the source.",
    "Cite sources inline like [1], [2], matching the numbered context items — and only cite an item for a claim that item actually contains.",
    "The student's citizenship group in the profile was determined by HelvetiStart from their nationality. Use it as given; never decide from your own knowledge which countries are or aren't in the EU/EFTA.",
    "If the student says a detail in their profile is wrong, believe them, answer for their corrected situation, and suggest they update their answers (click the HelvetiStart logo to start over) so their plan updates too.",
    "Many sources also describe rules for OTHER groups: non-EU/EFTA nationals, cross-border commuters, workers posted to Switzerland, or short-term work by people living abroad. Only state a rule if the context says it applies to someone in this student's situation; otherwise leave it out.",
    "The student is a STUDENT living in Switzerland with a residence permit for education. Rules for people who move to Switzerland to take up a job do not apply to them.",
    "VERIFIED RULES FOR THIS STUDENT (if given) were checked by HelvetiStart and are correct. Start your answer with EVERY rule that relates to the question (for a job: the hours they may work, health insurance, and a bank account). Restate each one for the student, speaking to them as \"you\" — don't copy the rule text, and don't make a rule stronger or weaker. Then add details from the CONTEXT. Never contradict them.",
    "Cite only numbered CONTEXT items, like [1]. Never put anything else in square brackets.",
    "Earlier messages in the conversation are for understanding follow-up questions (what \"it\" or \"that\" refers to). Their facts were checked before, but cite only the current CONTEXT.",
    "The \"If the student works\" rules apply as soon as the student says they work or have found a job.",
    ...(CHAT_TOOLS
      ? [
          "TOOLS: you can call tools before you answer. The CONTEXT already holds the passages that best match the question, so most questions need no tool. Passages a tool returns are numbered and are cited like CONTEXT items; a date or form a tool returns can be stated as it is.",
        ]
      : []),
    "The first sentence decides what the student takes away, so get it right before anything else. For a yes/no question (\"Can I…\", \"Do I have to…\", \"Is it enough…\"), first work out the answer for the exact situation the student describes (working or not working, as they say in the question), from the VERIFIED RULES and the CONTEXT. Then start with \"Yes\", \"No\" or \"Only if\" to match: \"No\" when a rule rules the option out in that situation, \"Yes\" when it is allowed, \"Only if\" when it depends on an approval or a condition. The first sentence must never contradict the bullets under it. For a question that is not yes/no, do not start with Yes or No.",
    "Format: start with ONE sentence that answers the question directly. Then, if there is more than one step, condition or requirement, list them as short bullet points (\"- \"), or a numbered list (\"1. \") when the order matters. Bold the most important fact in a bullet with **double asterisks**: a deadline, a limit, or something the student must or must not do. Bold only that fact, 2 to 6 words (e.g. **15 hours a week**, **within 14 days**), never a whole sentence, and at most one per bullet. Every bullet is a full sentence; never a bullet that is only a bold phrase. Never chain conditions in one sentence with semicolons; give each its own bullet. No headings and no tables. Keep it short: about 120 words at most. Finish with one short line telling them to confirm the details on the official source.",
    "Shape of a good answer (placeholder text, not facts):\nOne sentence that answers the question for the student's situation.\n- First condition, with the **key limit or deadline** in bold [1].\n- Second condition [2].\n- What to do first, e.g. **apply before you start** [1].\nConfirm the details on the official source.",
  ].join("\n");
  // The same rules that decide the plan's steps, so chat answers match the plan.
  // The rules differ for a student who works and one who doesn't, and showing
  // the model both sets at once made it mix them up ("Yes, you can keep your
  // private insurance while working"). So the server reads from the question
  // which situation is meant and gives the rules for that one only. When the
  // question doesn't say, the student's own answer decides, with the rules
  // that would change if they worked listed after it.
  let rules = "";
  let situationNote = "";
  if (audience && PLAN_AUDIENCES.has(audience)) {
    const asRule = (step: PlanStep) => `- ${step.title}: ${step.brief}`;
    const asked = workSituation(question);
    if (asked) {
      const working = asked === "working";
      rules = planSteps({ ...profile, plansToWork: working ? "Yes" : "No" }, audience)
        .map(asRule)
        .join("\n");
      situationNote = working
        ? "THE QUESTION IS ABOUT THE STUDENT WORKING IN SWITZERLAND. Answer for that situation only. The rules below are the ones that apply when they work."
        : "THE QUESTION IS ABOUT THE STUDENT NOT WORKING IN SWITZERLAND. Answer for that situation only. The rules below are the ones that apply when they don't work.";
    } else {
      const current = planSteps(profile, audience);
      rules = current.map(asRule).join("\n");
      if (profile.plansToWork !== "Yes") {
        const ifWorking = planSteps({ ...profile, plansToWork: "Yes" }, audience).filter(
          (w) => !current.some((c) => c.id === w.id && c.brief === w.brief),
        );
        rules += `\nIf the student works in Switzerland (these replace the rules above):\n${ifWorking
          .map(asRule)
          .join("\n")}`;
      }
    }
    // Private insurance isn't one of the onboarding choices for EU students, but
    // students ask about it (e.g. international student insurance).
    if (/insur|swisscare|krankenkasse|kvg/i.test(searchText)) {
      const whenWorking =
        "A student who works needs Swiss basic health insurance from a Swiss health insurer; a private insurance is then NOT enough and an exemption is not possible.";
      const whenNotWorking =
        "While the student does not work, a private insurance CAN be enough, but only if the cantonal Social Insurance Office approves an exemption for it; the office decides for each application, so the answer is \"only if the exemption is approved\".";
      rules += `\n- Private or international student insurance (e.g. from an international student insurer) is not Swiss basic health insurance. ${
        asked === "working"
          ? whenWorking
          : asked === "not-working"
            ? whenNotWorking
            : `${whenNotWorking} ${whenWorking}`
      }`;
    }
  }
  const keyFacts = facts.map((f, i) => `- ${f.value} [${i + 1}]`).join("\n");
  const user = `CONTEXT:\n${buildContext(chunks)}\n\n---\n${
    keyFacts
      ? `KEY FACTS (checked against the official sources; every one that relates to the question must be in your answer, with its exact figure):\n${keyFacts}\n\n---\n`
      : ""
  }${rules ? `${situationNote ? `${situationNote}\n` : ""}VERIFIED RULES FOR THIS STUDENT:\n${rules}\n\n---\n` : ""}${
    documents
      ? `DOCUMENTS THE STUDENT HAS UPLOADED (overview only; cite the numbered CONTEXT items):\n${documents}\n\n---\n`
      : ""
  }Student profile:\n${summarizeProfile(profile)}\n\n${
    attached.length
      ? `The student attached ${attached.map((d) => `"${d.filename}"`).join(" and ")} to this message. The question is about ${attached.length > 1 ? "those documents" : "that document"} unless it clearly says otherwise: answer from ${attached.length > 1 ? "their" : "its"} STUDENT'S OWN DOCUMENT items first, then add what the official sources require.\n\n`
      : ""
  }Question: ${question}${CHAT_TOOLS ? TOOL_HINTS : ""}`;

  try {
    // Earlier answers lose their [n] markers: those pointed at an earlier set
    // of sources, and would be confused with this answer's numbering.
    const earlier = history.map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("assistant" as const),
      content: m.text.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, ""),
    }));
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...earlier,
      { role: "user", content: user },
    ];
    // The model may ask for tools (tools.ts) before it answers. The server runs
    // them and returns the results; after CHAT_TOOL_ROUNDS it must answer.
    let raw = "";
    const toolsUsed: string[] = [];
    const toolResults: string[] = [];
    for (let round = 0; ; round++) {
      const mayUseTools = CHAT_TOOLS && round < CHAT_TOOL_ROUNDS;
      const turn = await chatTurn(messages, {
        temperature: 0.1,
        tools: mayUseTools ? TOOL_SPECS : undefined,
        signal: stopped.signal,
      });
      if (!mayUseTools || turn.toolCalls.length === 0) {
        raw = turn.content;
        break;
      }
      messages.push({ role: "assistant", content: turn.content, tool_calls: turn.toolCalls });
      for (const call of turn.toolCalls.slice(0, 3)) {
        const name = call.function?.name ?? "";
        const { result } = await runTool(name, call.function?.arguments ?? {}, { profile });
        let content: string;
        if (name === "search_sources" && Array.isArray(result)) {
          // New passages join the context under the next free numbers, so the
          // model can cite them and the citation check and source list see them.
          const found = (result as RetrievedChunk[]).filter(
            (hit) => !chunks.some((c) => chunkKey(c) === chunkKey(hit)),
          );
          content = found.length
            ? buildContext(found, chunks.length + 1)
            : "Nothing new: the CONTEXT already holds the best passages for that.";
          chunks.push(...found);
        } else {
          content = JSON.stringify(result);
        }
        toolsUsed.push(name);
        toolResults.push(content);
        messages.push({ role: "tool", tool_name: name, content });
      }
    }
    const grounded = dropUnsupportedNumbers(
      // The model sometimes copies the first line of the example answer.
      stripThinking(raw).replace(/^\s*One sentence that answers the question[^\n]*\n?/i, ""),
      [
        ...chunks.map((c) => c.text),
        // Figures and dates a tool returned count as supported.
        ...toolResults,
        documents,
        summarizeProfile(profile),
        question,
        ...history.map((m) => m.text),
      ].join(" "),
    );
    // The model sometimes leaves a key fact out, or states a figure that
    // contradicts one: fix both in code, so the answer always has them.
    const answer = ensureFacts(insuranceWhileWorking(grounded, question), facts, "bullets", {
      citation: (f) => `[${facts.indexOf(f) + 1}]`,
      knownFacts: allFacts,
    }).text;
    const sources = sourceList(chunks);
    if (stopped.signal.aborted) return;
    if (signedIn) {
      const save = db.prepare(
        "INSERT INTO chat_messages (user_id, role, text, sources, attachments) VALUES (?, ?, ?, ?, ?)",
      );
      db.transaction(() => {
        save.run(userId, "user", question, "[]", JSON.stringify(attached.map((d) => d.filename)));
        save.run(userId, "ai", answer, JSON.stringify(sources), "[]");
      })();
    }
    res.json({ answer, sources, model: LLM_MODEL, tools: toolsUsed });
  } catch (err) {
    if (stopped.signal.aborted) return; // nobody is waiting for a reply
    res.status(502).json({ error: (err as Error).message });
  }
});

// --- Personalised relocation plan ---------------------------------------------
// Rules decide the steps, tools fetch their evidence, the model writes each
// step's text, checks ground it (see plan.ts).

// Can a plan be built for this profile? If not, the reply to send instead.
function planRefusal(audience: "eu" | "non-eu" | null) {
  // A plan needs a known citizenship group, since the rules differ for EU/EFTA
  // and non-EU students.
  if (audience && PLAN_AUDIENCES.has(audience)) return null;
  return {
    stops: [],
    sources: [],
    unsupported: true,
    note: audience
      ? "HelvetiStart doesn't build plans for your citizenship group yet."
      : "HelvetiStart couldn't tell your citizenship group from your answer. Check the spelling of your citizenship and try again.",
  };
}

// The whole plan in one reply (used by the benchmark and simple clients).
app.post("/api/plan", async (req, res) => {
  // The citizenship group is always recomputed here, never trusted from the browser.
  const profile = withServerStatus(req.body?.profile ?? {});
  const audience = audienceFor(String(profile.status ?? ""));
  const refusal = planRefusal(audience);
  if (refusal || !audience) return res.json(refusal);
  try {
    // `fresh: true` ignores the stored steps (used by the benchmark script).
    res.json(await buildPlan(profile, audience, { fresh: req.body?.fresh === true }));
  } catch (err) {
    res.status(502).json({ error: `Could not build the plan: ${(err as Error).message}` });
  }
});

// The same plan as a stream of JSON lines: first every step with the parts the
// rules decide (and any text already written), then each remaining step as the
// model finishes it. The app shows the plan from the first line on.
app.post("/api/plan/stream", async (req, res) => {
  const profile = withServerStatus(req.body?.profile ?? {});
  const audience = audienceFor(String(profile.status ?? ""));
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  const send = (event: PlanEvent | { type: "error"; error: string } | { type: "done"; plan: unknown }) =>
    res.write(`${JSON.stringify(event)}\n`);
  const refusal = planRefusal(audience);
  if (refusal || !audience) {
    send({ type: "done", plan: refusal });
    return res.end();
  }
  try {
    await buildPlan(profile, audience, { fresh: req.body?.fresh === true, onEvent: send });
  } catch (err) {
    send({ type: "error", error: `Could not build the plan: ${(err as Error).message}` });
  }
  res.end();
});

// --- Feedback when a stop is completed (recalculate / short note) ------------
app.post("/api/plan/feedback", async (req, res) => {
  // The citizenship group is always recomputed here, never trusted from the browser.
  const profile = withServerStatus(req.body?.profile ?? {});
  const completedTitle = String(req.body?.completedTitle ?? "").trim();
  const remaining: string[] = Array.isArray(req.body?.remaining)
    ? req.body.remaining.map((s: unknown) => String(s))
    : [];
  if (!completedTitle) return res.status(400).json({ error: "completedTitle is required." });
  if (!(await llmAvailable())) {
    return res.status(503).json({ error: "The local AI model isn't reachable. Start Ollama." });
  }

  let chunks: RetrievedChunk[] = [];
  try {
    chunks = await retrieve(`After completing: ${completedTitle}. What comes next?`, {
      status: String(profile.status ?? ""),
      k: 4,
    });
  } catch {
    // feedback can still work without context
  }

  const system = [
    "You are HelvetiStart. The student just completed a relocation step.",
    "In 1-2 short, encouraging sentences, confirm what this unlocks and what to focus on next.",
    "Use ONLY the CONTEXT if provided; do not invent specific figures, offices, or deadlines. No URLs needed.",
  ].join("\n");
  const user = `${
    chunks.length ? `CONTEXT:\n${buildContext(chunks)}\n\n---\n` : ""
  }Student profile:\n${summarizeProfile(
    profile,
  )}\n\nJust completed: "${completedTitle}".\nRemaining steps: ${
    remaining.join(", ") || "(unknown)"
  }\n\nGive the short feedback now.`;

  try {
    const raw = await chat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0.3 },
    );
    res.json({
      feedback: dropUnsupportedNumbers(
        stripThinking(raw),
        `${chunks.map((c) => c.text).join(" ")} ${summarizeProfile(profile)}`,
      ),
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Errors from the body parsers (e.g. an upload that is too large) as JSON.
app.use(
  (err: { type?: string; status?: number; message?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    if (err.type === "entity.too.large") {
      return res.status(413).json({ error: `That file is too large. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` });
    }
    res.status(err.status ?? 500).json({ error: err.message ?? "Something went wrong." });
  },
);

app.listen(PORT, () => {
  console.log(`HelvetiStart backend running at http://localhost:${PORT}`);
  // Write the plan steps ahead of time (does nothing if Ollama isn't running
  // or the knowledge base is empty; PLAN_PREWARM=false turns it off).
  void prewarmPlans();
});
