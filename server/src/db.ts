import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

// Resolve a stable path to /server/data regardless of where we run from.
const dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, "app.db"));
db.pragma("journal_mode = WAL"); // better concurrent read/write behaviour
db.pragma("foreign_keys = ON"); // enforce relationships between tables

// --- Schema -----------------------------------------------------------------
// Tables are created only if they don't already exist, so restarting the
// server never wipes your data.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS profiles (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email      TEXT NOT NULL DEFAULT '',
    first_name TEXT NOT NULL DEFAULT '',
    nationality TEXT NOT NULL DEFAULT '',
    age        TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT '',
    university TEXT NOT NULL DEFAULT '',
    degree     TEXT NOT NULL DEFAULT '',
    canton     TEXT NOT NULL DEFAULT '',
    arrival    TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY,
    phase       TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    deadline    TEXT NOT NULL,
    time        TEXT NOT NULL,
    source      TEXT NOT NULL,
    source_url  TEXT NOT NULL,
    documents   TEXT NOT NULL DEFAULT '[]',
    email_to    TEXT
  );

  CREATE TABLE IF NOT EXISTS progress (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    completed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, task_id)
  );

  -- Local knowledge base: chunks of official Swiss pages + their embeddings.
  -- 'embedding' is a JSON array of floats; we do cosine similarity in JS.
  CREATE TABLE IF NOT EXISTS kb_chunks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id   TEXT NOT NULL,
    title       TEXT NOT NULL,
    url         TEXT NOT NULL,
    topic       TEXT NOT NULL,
    applies_to  TEXT NOT NULL DEFAULT 'all',
    lang        TEXT NOT NULL DEFAULT 'en',
    chunk_index INTEGER NOT NULL,
    text        TEXT NOT NULL,
    embedding   TEXT NOT NULL,
    fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// --- Migrations ---------------------------------------------------------------
// Add columns introduced after the first version, without touching existing data.
export function addColumnIfMissing(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing("kb_chunks", "authority", "TEXT NOT NULL DEFAULT 'official'");
// Vectors from different embedding models can't be compared, so each chunk
// records which model made it. Rows from before this column used nomic-embed-text.
addColumnIfMissing("kb_chunks", "embed_model", "TEXT NOT NULL DEFAULT 'nomic-embed-text'");

// Set on chunks from a university's own pages (see Source.institution).
addColumnIfMissing("kb_chunks", "institution", "TEXT");

// A fingerprint of each source's text at the last ingest, so a changed official
// page (e.g. a new rule) is reported for review instead of slipping in unnoticed.
db.exec(`
  CREATE TABLE IF NOT EXISTS kb_sources (
    source_id    TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    checked_at   TEXT NOT NULL DEFAULT (datetime('now')),
    changed_at   TEXT
  );
`);

// The "Ask HelvetiStart" conversation, per user, so the assistant remembers what
// was said earlier and a returning student can continue where they left off.
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('user', 'ai')),
    text       TEXT NOT NULL,
    sources    TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS chat_messages_user ON chat_messages (user_id, id);
`);
// File names of the documents the student sent along with a message.
addColumnIfMissing("chat_messages", "attachments", "TEXT NOT NULL DEFAULT '[]'");

// Generated plans, keyed by a hash of everything the model was given (profile,
// evidence, forms, prompt, model). Same inputs -> same plan, served instantly.
db.exec(`
  CREATE TABLE IF NOT EXISTS plan_cache (
    key        TEXT PRIMARY KEY,
    plan       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// The text the model wrote for ONE plan step, keyed by a hash of everything it
// was given for that step (the step's brief, its evidence, the answers that
// shape it, the prompt and the model). Students in the same situation share a
// step even when the rest of their plan differs, so most plans are assembled
// from steps that are already written.
db.exec(`
  CREATE TABLE IF NOT EXISTS plan_step_cache (
    key        TEXT PRIMARY KEY,
    step_id    TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Onboarding answers used to personalise the plan.
addColumnIfMissing("profiles", "plans_to_work", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("profiles", "stay_length", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("profiles", "municipality", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("profiles", "housing_status", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("profiles", "health_coverage", "TEXT NOT NULL DEFAULT ''");

// --- Seed tasks -------------------------------------------------------------
// These are the same 6 tasks that were hardcoded in the frontend (src/App.tsx).
// We insert them once, only if the tasks table is empty.
type SeedTask = {
  id: number;
  phase: string;
  title: string;
  description: string;
  deadline: string;
  time: string;
  source: string;
  source_url: string;
  documents: string[];
  email_to?: string;
};

const seedTasks: SeedTask[] = [
  {
    id: 1,
    phase: "Before you arrive",
    title: "Apply for your student visa",
    description:
      "Submit your national visa D application to the Swiss representation in your country of residence.",
    deadline: "Start now",
    time: "6–12 weeks",
    source: "State Secretariat for Migration",
    source_url: "https://www.sem.admin.ch/",
    documents: ["Admission letter", "Proof of funds", "Valid passport"],
    email_to: "Swiss representation",
  },
  {
    id: 2,
    phase: "Before you arrive",
    title: "Secure accommodation",
    description:
      "Arrange a Bern address before arrival. You'll need your rental agreement for local registration.",
    deadline: "Before 24 Aug",
    time: "2–4 weeks",
    source: "BFH International Office",
    source_url: "https://www.bfh.ch/",
    documents: ["Admission letter", "Passport copy"],
    email_to: "BFH Housing Office",
  },
  {
    id: 3,
    phase: "First week in Bern",
    title: "Register with your commune",
    description:
      "Visit your residents' registration office within 14 days of arrival and before starting your studies.",
    deadline: "By 7 Sep",
    time: "45 min",
    source: "City of Bern",
    source_url: "https://www.bern.ch/",
    documents: ["Passport", "Rental agreement", "Passport photo", "Admission letter"],
    email_to: "Residents' Registration Office",
  },
  {
    id: 4,
    phase: "First month",
    title: "Open a Swiss bank account",
    description:
      "Choose a student account for rent, health insurance, and everyday payments after registration.",
    deadline: "By 24 Sep",
    time: "30 min",
    source: "BFH Welcome Guide",
    source_url: "https://www.bfh.ch/",
    documents: ["Passport", "Registration confirmation", "Student ID"],
  },
  {
    id: 5,
    phase: "First three months",
    title: "Arrange health insurance",
    description:
      "Take out Swiss basic insurance or request an exemption if your existing policy offers equivalent coverage.",
    deadline: "By 24 Nov",
    time: "1–2 hours",
    source: "Federal Office of Public Health",
    source_url: "https://www.bag.admin.ch/",
    documents: ["Insurance policy", "Residence permit", "Confirmation of study"],
    email_to: "Cantonal Health Insurance Office",
  },
  {
    id: 6,
    phase: "Settle in",
    title: "Get your student transport pass",
    description:
      "Compare the Libero network pass and the SBB Half Fare Travelcard for your regular journeys.",
    deadline: "When ready",
    time: "20 min",
    source: "SBB",
    source_url: "https://www.sbb.ch/",
    documents: ["Passport", "Passport photo", "Student ID"],
  },
];

const taskCount = db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number };
if (taskCount.n === 0) {
  const insert = db.prepare(`
    INSERT INTO tasks (id, phase, title, description, deadline, time, source, source_url, documents, email_to)
    VALUES (@id, @phase, @title, @description, @deadline, @time, @source, @source_url, @documents, @email_to)
  `);
  const insertMany = db.transaction((rows: SeedTask[]) => {
    for (const row of rows) {
      insert.run({
        ...row,
        documents: JSON.stringify(row.documents),
        email_to: row.email_to ?? null,
      });
    }
  });
  insertMany(seedTasks);
  console.log(`Seeded ${seedTasks.length} tasks into the database.`);
}
