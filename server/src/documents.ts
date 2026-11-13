// Documents a student uploads (admission letter, rental agreement, insurance
// policy, ...). Each one is read on this machine: text is taken out of PDFs and
// text files directly, and photos or screenshots are transcribed by the local
// vision model. The local model then summarises it, and its chunks are embedded
// so the assistant can find the parts that answer a question.
// Files are kept only in the local SQLite database and can be deleted at any time.

import { db } from "./db.js";
import { extractText as extractPdfPages, getDocumentProxy, renderPageAsImage } from "unpdf";
import { chunkText } from "./knowledge.js";
import { chat, embed, embedMany, EMBED_MODEL, stripThinking, VISION_MODEL } from "./llm.js";
import { numbersSupported } from "./grounding.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS user_documents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename    TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),
    error       TEXT,
    text        TEXT NOT NULL DEFAULT '',
    doc_type    TEXT NOT NULL DEFAULT '',
    summary     TEXT NOT NULL DEFAULT '',
    key_details TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS user_documents_user ON user_documents (user_id, id);

  CREATE TABLE IF NOT EXISTS user_document_chunks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES user_documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    text        TEXT NOT NULL,
    embedding   TEXT NOT NULL,
    embed_model TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS user_document_chunks_doc ON user_document_chunks (document_id);
`);

// A document still "processing" when the server stopped will never finish.
db.prepare(
  `UPDATE user_documents SET status = 'failed', error = 'Reading was interrupted. Please upload it again.'
    WHERE status = 'processing'`,
).run();

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_CHARS = 300_000;
const MAX_CHUNKS = 250;
// How much of the document the summary pass reads (the model's context is limited).
const SUMMARY_CHARS = 10_000;
// Scanned pages are read one by one by the vision model (roughly 20-60 s each
// on a laptop), so very long scans are only read up to this many pages.
const MAX_SCANNED_PAGES = 10;
// A page with less text than this has no real text layer: it is a scan or photo.
const MIN_PAGE_TEXT = 30;
// Long side of a rendered page in pixels: enough for small print, small enough to stay quick.
const PAGE_RENDER_SIDE = 1400;

type Kind = "pdf" | "image" | "text";

/** What kind of file this is, from its type or name; null if it isn't supported. */
export function documentKind(filename: string, mime: string): Kind | null {
  const name = filename.toLowerCase();
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  // The app converts other image formats (HEIC, WebP...) to JPEG before uploading.
  if (/^image\/(png|jpe?g)$/.test(mime) || /\.(png|jpe?g)$/.test(name)) return "image";
  if (mime.startsWith("text/") || /\.(txt|md|csv)$/.test(name)) return "text";
  return null;
}

export const SUPPORTED_TYPES = "PDF, PNG, JPG, TXT, MD or CSV";

export type KeyDetail = { label: string; value: string };

export type DocumentInfo = {
  id: number;
  filename: string;
  mime: string;
  size: number;
  status: "processing" | "ready" | "failed";
  error: string | null;
  documentType: string;
  summary: string;
  keyDetails: KeyDetail[];
  createdAt: string;
};

type DocumentRow = {
  id: number;
  filename: string;
  mime: string;
  size: number;
  status: DocumentInfo["status"];
  error: string | null;
  doc_type: string;
  summary: string;
  key_details: string;
  created_at: string;
};

const toInfo = (r: DocumentRow): DocumentInfo => ({
  id: r.id,
  filename: r.filename,
  mime: r.mime,
  size: r.size,
  status: r.status,
  error: r.error,
  documentType: r.doc_type,
  summary: r.summary,
  keyDetails: JSON.parse(r.key_details) as KeyDetail[],
  createdAt: r.created_at,
});

const INFO_COLUMNS = "id, filename, mime, size, status, error, doc_type, summary, key_details, created_at";

export function listDocuments(userId: number): DocumentInfo[] {
  const rows = db
    .prepare(`SELECT ${INFO_COLUMNS} FROM user_documents WHERE user_id = ? ORDER BY id DESC`)
    .all(userId) as DocumentRow[];
  return rows.map(toInfo);
}

export function getDocument(userId: number, id: number): DocumentInfo | undefined {
  const row = db
    .prepare(`SELECT ${INFO_COLUMNS} FROM user_documents WHERE user_id = ? AND id = ?`)
    .get(userId, id) as DocumentRow | undefined;
  return row && toInfo(row);
}

export function deleteDocument(userId: number, id: number): boolean {
  return db.prepare("DELETE FROM user_documents WHERE user_id = ? AND id = ?").run(userId, id).changes > 0;
}

// --- Reading a file -----------------------------------------------------------

async function transcribeImage(bytes: Buffer): Promise<string> {
  const reply = await chat(
    [
      {
        role: "user",
        content:
          "Transcribe ALL the text in this document image, exactly as written and in its original language. " +
          "Keep names, dates, amounts and reference numbers exactly as shown. Keep the reading order; " +
          "write table rows as lines. Output only the transcribed text, no comments. " +
          "If the image contains no text, describe briefly what it shows.",
        images: [bytes.toString("base64")],
      },
    ],
    // The vision model is only needed now and then: free its memory soon after.
    // A page of text is well under 2500 tokens; the cap and the repeat penalty
    // stop the model when it gets stuck writing the same line over and over.
    { model: VISION_MODEL, temperature: 0, think: false, keepAlive: "2m", maxTokens: 2500, repeatPenalty: 1.1 },
  );
  return dropRepeatedLines(stripThinking(reply));
}

/** Remove a line the model wrote again and again (keeps its first two copies). */
function dropRepeatedLines(text: string): string {
  const seen = new Map<string, number>();
  return text
    .split("\n")
    .filter((line) => {
      const key = line.trim().toLowerCase();
      if (!key) return true;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      return count <= 2;
    })
    .join("\n");
}

/** A rendered page on a white background, as JPEG: transparent areas otherwise read as black. */
async function flattenToJpeg(png: ArrayBuffer): Promise<Buffer> {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const image = await loadImage(Buffer.from(png));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, image.width, image.height);
  context.drawImage(image, 0, 0);
  return canvas.encode("jpeg", 90);
}

/**
 * Text of a PDF, page by page. Pages with a text layer are read directly; a
 * scanned page (a photo or scan saved as PDF) is rendered to an image and
 * transcribed by the vision model, so scans and mixed PDFs both work.
 */
async function readPdf(bytes: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text: pages } = await extractPdfPages(pdf, { mergePages: false });
  const parts: string[] = [];
  let scanned = 0;
  let skipped = 0;
  for (let i = 0; i < pages.length; i++) {
    const pageText = pages[i].replace(/\s+/g, " ").trim();
    if (pageText.length >= MIN_PAGE_TEXT) {
      parts.push(pageText);
      continue;
    }
    if (scanned >= MAX_SCANNED_PAGES) {
      skipped++;
      continue;
    }
    scanned++;
    const viewport = (await pdf.getPage(i + 1)).getViewport({ scale: 1 });
    const scale = Math.min(4, PAGE_RENDER_SIDE / Math.max(viewport.width, viewport.height));
    const png = await renderPageAsImage(pdf, i + 1, {
      canvasImport: () => import("@napi-rs/canvas"),
      scale,
    });
    parts.push(await transcribeImage(await flattenToJpeg(png)));
  }
  if (skipped > 0) {
    parts.push(`[${skipped} more scanned page(s) were not read: only the first ${MAX_SCANNED_PAGES} are.]`);
  }
  return parts.join("\n\n");
}

async function extractText(kind: Kind, bytes: Buffer): Promise<string> {
  let text: string;
  if (kind === "pdf") {
    text = await readPdf(bytes);
  } else if (kind === "image") {
    text = await transcribeImage(bytes);
  } else {
    text = new TextDecoder().decode(bytes);
  }
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new Error("No text could be read from this file.");
  return text.slice(0, MAX_TEXT_CHARS);
}

// --- Understanding it ---------------------------------------------------------

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    documentType: { type: "string" },
    summary: { type: "string" },
    keyDetails: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: { label: { type: "string" }, value: { type: "string" } },
        required: ["label", "value"],
      },
    },
  },
  required: ["documentType", "summary", "keyDetails"],
};

type Analysis = { documentType: string; summary: string; keyDetails: KeyDetail[] };

async function analyse(filename: string, text: string): Promise<Analysis> {
  const system = [
    "You read documents that an international student moving to Bern, Switzerland has uploaded, such as an admission letter, rental agreement, insurance policy, passport, bank statement or an official letter.",
    "Describe ONLY what the document itself says. Never add facts, rules or advice from your own knowledge.",
    "Write in plain English, even when the document is in German, French or Italian.",
    "Common Swiss terms: Wohnsitzbescheinigung = certificate of residence; Einwohnerdienste / Einwohnerregister = residents' registration office / register; Zuzug = moving in (a place next to it is where the person moved FROM, not where they are registered); Wegzug = moving away; Kurzaufenthalt L = short-term residence permit (L permit); Aufenthalt B = residence permit (B permit); Mietvertrag = rental agreement; Mietzinsdepot / Mietkaution = rent deposit; Nebenkosten = utility costs; Krankenkasse / Grundversicherung = health insurance / basic insurance; Prämie = premium; Franchise = deductible; Frist = deadline.",
    "Pay slip terms (German / French): AHV / AVS = old-age and survivors' insurance; IV / AI = disability insurance; EO / APG = income compensation; ALV / AC = unemployment insurance; NBU / AANP = insurance for accidents outside work; BU / AAP = occupational accident insurance; KTG / IJM = daily sickness allowance insurance (pays wages during illness); BVG / LPP = occupational pension (2nd pillar); Quellensteuer / impôt à la source (IS) = tax at source; Bruttolohn / salaire brut = gross wage; Nettolohn / salaire net = net wage; 13. Monatslohn / 13e salaire = 13th-month wage. These deductions are social insurance contributions, not tax, unless the line is tax at source. Health insurance premiums are never deducted from wages in Switzerland.",
    "Fields:",
    '- documentType: what the document is, in a few words (e.g. "Rental agreement", "Admission letter").',
    "- summary: two or three sentences: who issued it, what it is about, and anything the student must do or note (deadlines, payments, conditions). Only state an obligation the document itself states.",
    "- keyDetails: up to 8 of the most useful facts, e.g. names, dates, amounts, addresses, reference numbers, deadlines. Keep each value short (a few words). Copy names, dates, amounts, addresses and reference numbers EXACTLY as written in the document, including the date format, but write any other words in English.",
  ].join("\n");
  const user = `File name: ${filename}\n\nDOCUMENT TEXT:\n${text.slice(0, SUMMARY_CHARS)}${
    text.length > SUMMARY_CHARS ? "\n[... the document continues ...]" : ""
  }`;
  const reply = await chat(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature: 0, format: SUMMARY_SCHEMA },
  );
  const parsed = JSON.parse(stripThinking(reply)) as Partial<Analysis>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  // The same grounding check as everywhere else: a figure that isn't in the
  // document was made up, so that detail or sentence is left out.
  const keyDetails = (Array.isArray(parsed.keyDetails) ? parsed.keyDetails : [])
    .map((d) => ({ label: str(d?.label), value: str(d?.value) }))
    .filter((d) => d.label && d.value && numbersSupported(d.value, text));
  const summary = str(parsed.summary)
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => numbersSupported(sentence, text))
    .join(" ");
  return { documentType: str(parsed.documentType) || "Document", summary, keyDetails };
}

// --- Processing ---------------------------------------------------------------

// One document at a time, so several uploads don't compete for the local model.
let queue: Promise<void> = Promise.resolve();

/** Store an uploaded file and start reading it in the background. */
export function addDocument(
  userId: number,
  file: { filename: string; mime: string; bytes: Buffer },
): DocumentInfo {
  const kind = documentKind(file.filename, file.mime);
  if (!kind) throw new Error(`Unsupported file type. Upload a ${SUPPORTED_TYPES} file.`);
  const info = db
    .prepare("INSERT INTO user_documents (user_id, filename, mime, size) VALUES (?, ?, ?, ?)")
    .run(userId, file.filename, file.mime, file.bytes.length);
  const id = Number(info.lastInsertRowid);
  queue = queue.then(() => processDocument(id, kind, file.filename, file.bytes));
  return getDocument(userId, id)!;
}

async function processDocument(id: number, kind: Kind, filename: string, bytes: Buffer) {
  const stillThere = () => !!db.prepare("SELECT id FROM user_documents WHERE id = ?").get(id);
  try {
    if (!stillThere()) return; // deleted while waiting in the queue
    const text = await extractText(kind, bytes);
    const chunks = chunkText(text.replace(/\s+/g, " ")).slice(0, MAX_CHUNKS);
    const vectors = await embedMany(chunks, "document");
    const analysis = await analyse(filename, text);
    if (!stillThere()) return;
    const insert = db.prepare(
      `INSERT INTO user_document_chunks (document_id, chunk_index, text, embedding, embed_model)
       VALUES (?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      chunks.forEach((chunk, i) => insert.run(id, i, chunk, JSON.stringify(vectors[i]), EMBED_MODEL));
      db.prepare(
        `UPDATE user_documents
            SET status = 'ready', error = NULL, text = ?, doc_type = ?, summary = ?, key_details = ?
          WHERE id = ?`,
      ).run(text, analysis.documentType, analysis.summary, JSON.stringify(analysis.keyDetails), id);
    })();
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`Reading document ${id} (${filename}) failed: ${message}`);
    db.prepare("UPDATE user_documents SET status = 'failed', error = ? WHERE id = ?").run(
      /Local LLM|Embedding|fetch failed/i.test(message)
        ? "The local AI model couldn't read this file. Check that Ollama is running, then upload it again."
        : message,
      id,
    );
  }
}

// --- Finding the parts that answer a question ---------------------------------

export type DocumentChunk = { documentId: number; filename: string; documentType: string; text: string; score: number };

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * The student's document passages that best match a question. A short document
 * is given whole, since questions like "what is this letter about?" don't match
 * any one passage well. `onlyIds` limits the search to those documents (the
 * ones the student attached to this message).
 */
export async function retrieveDocumentChunks(
  userId: number,
  query: string,
  k = 4,
  onlyIds?: number[],
): Promise<DocumentChunk[]> {
  const all = db
    .prepare(
      `SELECT d.id AS documentId, d.filename, d.doc_type AS documentType, c.text, c.embedding
         FROM user_document_chunks c JOIN user_documents d ON d.id = c.document_id
        WHERE d.user_id = ? AND d.status = 'ready' AND c.embed_model = ?
        ORDER BY d.id DESC, c.chunk_index`,
    )
    .all(userId, EMBED_MODEL) as (Omit<DocumentChunk, "score"> & { embedding: string })[];
  const rows = onlyIds ? all.filter((r) => onlyIds.includes(r.documentId)) : all;
  if (rows.length === 0) return [];
  if (rows.length <= k) return rows.map(({ embedding: _e, ...r }) => ({ ...r, score: 1 }));
  const q = await embed(query, "query");
  return rows
    .map(({ embedding, ...r }) => ({ ...r, score: cosine(q, JSON.parse(embedding) as number[]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** A short overview of every document the student has uploaded, for the prompt. */
export function documentOverview(userId: number): string {
  return listDocuments(userId)
    .filter((d) => d.status === "ready")
    .map((d) => `- "${d.filename}" (${d.documentType}): ${d.summary}`)
    .join("\n");
}
