// Local knowledge base: fetches official pages/PDFs (through the allow-list) and
// reads local coordinator notes, turns them into text chunks with embeddings,
// stores them in SQLite, and retrieves the most relevant chunks for a query.
// Everything runs on-device.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";
import { db } from "./db.js";
import { EMBED_MODEL, embedMany } from "./llm.js";
import { safeFetchRaw } from "./allowlist.js";
import { Institution, SOURCES, Source } from "./sources.js";

// Small chunks keep each one about a single rule, so it can be found on its own.
// The cap only guards against runaway pages: long FAQ pages keep their student
// sections near the end (e.g. SEM's work FAQ, chunk 30 of 36), so it must be high.
const DEFAULT_MAX_CHUNKS = 150;
const CHUNK_SIZE = 600;

const KNOWLEDGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "knowledge");

/**
 * Strip HTML to readable text, dropping navigation, headers, footers and form widgets.
 * When the page marks its main content (<main>), only that part is read: menus,
 * breadcrumbs and cookie notices around it would otherwise fill chunks with
 * text that matches every search and says nothing.
 */
export function extractHtmlText(html: string): string {
  const main = html.match(/<main\b[\s\S]*<\/main>/i)?.[0];
  if (main) {
    // The page title names the topic, so keep it even though it sits outside <main>.
    const pageTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
    const text = htmlToText(`${pageTitle}. ${main}`);
    // Some pages keep their content outside <main>; then read the whole page.
    if (text.length >= 400) return text;
  }
  return htmlToText(html);
}

function htmlToText(html: string): string {
  let t = html
    .replace(/<(script|style|noscript|nav|header|footer|select|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  t = t
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    // Numeric entities, e.g. "EU&#x2F;EFTA" on the new SEM pages.
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&[a-z]+;/gi, " ");
  return t.replace(/\s+/g, " ").trim();
}

export async function extractPdf(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractPdfText(pdf, { mergePages: true });
  return text.replace(/\s+/g, " ").trim();
}

/** Load a source's text: local file, PDF, or HTML page. */
async function loadSourceText(src: Source): Promise<string> {
  if (src.localPath) {
    const file = path.join(KNOWLEDGE_DIR, src.localPath);
    return (await fs.readFile(file, "utf8")).replace(/\s+/g, " ").trim();
  }
  // allow-list enforced inside safeFetchRaw. Official sites sometimes answer
  // with a passing error when several pages are read in a row: try again
  // before giving the source up for this ingest.
  let doc: Awaited<ReturnType<typeof safeFetchRaw>> | undefined;
  for (let attempt = 1; !doc; attempt++) {
    try {
      doc = await safeFetchRaw(src.url);
    } catch (err) {
      const passing = /with 5\d\d|aborted|fetch failed/i.test((err as Error).message);
      if (!passing || attempt >= 3) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  const isPdf = doc.contentType.includes("pdf") || /\.pdf($|\?)/i.test(doc.finalUrl);
  return isPdf ? extractPdf(doc.bytes) : extractHtmlText(new TextDecoder().decode(doc.bytes));
}

/**
 * Split text into chunks at sentence boundaries, so a rule is never cut in half
 * (e.g. "As an EU/EFTA citizen you can work 15 hours a week" losing its subject).
 * Each chunk repeats the previous chunk's last sentence for context.
 */
export function chunkText(text: string): string[] {
  // Sentences end at . ! or ? (FAQ questions end at "?"). Run-ons longer than
  // a chunk, such as navigation lists, are cut at the chunk size.
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .flatMap((s) => s.match(new RegExp(`[\\s\\S]{1,${CHUNK_SIZE}}`, "g")) ?? []);
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const sentence of sentences) {
    if (length + sentence.length > CHUNK_SIZE && current.length > 0) {
      chunks.push(current.join(" "));
      const last = current[current.length - 1];
      current = last.length < CHUNK_SIZE / 2 ? [last] : [];
      length = current.reduce((n, s) => n + s.length + 1, 0);
    }
    current.push(sentence);
    length += sentence.length + 1;
  }
  if (current.length > 0) chunks.push(current.join(" "));
  return chunks;
}

export type IngestResult = {
  sources: number;
  totalChunks: number;
  perSource: { id: string; ok: boolean; chunks?: number; reason?: string }[];
  /** Sources whose text changed since the last ingest — these need a human look. */
  changed: { id: string; title: string; url: string; topic: string }[];
};

/** (Re)build the whole knowledge base from the curated sources. */
export async function ingestAll(): Promise<IngestResult> {
  const perSource: IngestResult["perSource"] = [];

  const insert = db.prepare(`
    INSERT INTO kb_chunks (source_id, title, url, topic, applies_to, lang, authority, institution, chunk_index, text, embedding, embed_model)
    VALUES (@source_id, @title, @url, @topic, @applies_to, @lang, @authority, @institution, @chunk_index, @text, @embedding, @embed_model)
  `);
  const previousHash = db.prepare("SELECT content_hash FROM kb_sources WHERE source_id = ?");
  const saveHash = db.prepare(`
    INSERT INTO kb_sources (source_id, content_hash, checked_at, changed_at)
    VALUES (@id, @hash, datetime('now'), NULL)
    ON CONFLICT(source_id) DO UPDATE SET
      checked_at = datetime('now'),
      changed_at = CASE WHEN content_hash != excluded.content_hash THEN datetime('now') ELSE changed_at END,
      content_hash = excluded.content_hash
  `);
  const changed: IngestResult["changed"] = [];
  const clearSource = db.prepare("DELETE FROM kb_chunks WHERE source_id = ?");

  // Drop chunks of sources that are no longer in the curated list.
  const known = new Set(SOURCES.map((s) => s.id));
  const stored = db.prepare("SELECT DISTINCT source_id FROM kb_chunks").all() as {
    source_id: string;
  }[];
  for (const { source_id } of stored) if (!known.has(source_id)) clearSource.run(source_id);

  for (const src of SOURCES) {
    try {
      const text = await loadSourceText(src);
      if (text.length < 200) {
        perSource.push({ id: src.id, ok: false, reason: "too little text extracted" });
        continue;
      }
      const hash = createHash("sha256").update(text).digest("hex");
      const before = previousHash.get(src.id) as { content_hash: string } | undefined;
      if (before && before.content_hash !== hash) {
        changed.push({ id: src.id, title: src.title, url: src.url, topic: src.topic });
      }
      const chunks = chunkText(text).slice(0, src.maxChunks ?? DEFAULT_MAX_CHUNKS);

      // Embed first, then swap the source's chunks in one transaction.
      // The source's title is embedded with every chunk: a passage like "You
      // must apply within three months" says nothing about WHAT is applied for
      // until it carries its page's name. Only the search vector includes the
      // title; the stored text stays the source's own words.
      const vectors = await embedMany(
        chunks.map((chunk) => `${src.title}\n${chunk}`),
        "document",
      );
      db.transaction(() => {
        clearSource.run(src.id);
        chunks.forEach((chunk, ci) =>
          insert.run({
            source_id: src.id,
            title: src.title,
            url: src.url,
            topic: src.topic,
            applies_to: src.appliesTo,
            lang: src.lang,
            authority: src.authority,
            institution: src.institution ?? null,
            chunk_index: ci,
            text: chunk,
            embedding: JSON.stringify(vectors[ci]),
            embed_model: EMBED_MODEL,
          }),
        );
        saveHash.run({ id: src.id, hash });
      })();
      perSource.push({ id: src.id, ok: true, chunks: chunks.length });
    } catch (err) {
      perSource.push({ id: src.id, ok: false, reason: (err as Error).message });
    }
  }

  chunkCache = null; // reload the new chunks on the next search
  searchMemo.clear();
  const totalChunks = (db.prepare("SELECT COUNT(*) AS n FROM kb_chunks").get() as { n: number }).n;
  return { sources: SOURCES.length, totalChunks, perSource, changed };
}

/** Sources whose text changed at an ingest, newest first, for review. */
export function recentSourceChanges(limit = 20) {
  const titles = new Map(SOURCES.map((src) => [src.id, src]));
  const rows = db
    .prepare(
      `SELECT source_id, changed_at FROM kb_sources
        WHERE changed_at IS NOT NULL ORDER BY changed_at DESC LIMIT ?`,
    )
    .all(limit) as { source_id: string; changed_at: string }[];
  return rows.map((r) => {
    const src = titles.get(r.source_id);
    return {
      id: r.source_id,
      changedAt: r.changed_at,
      title: src?.title ?? r.source_id,
      url: src?.url ?? "",
      topic: src?.topic ?? "",
    };
  });
}

function norm(v: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

function cosineSimilarity(a: number[], aNorm: number, b: Float32Array, bNorm: number): number {
  if (aNorm === 0 || bNorm === 0 || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (aNorm * bNorm);
}

/** Map a profile status string to an audience filter. */
export function audienceFor(status?: string): "eu" | "non-eu" | null {
  const s = (status ?? "").toLowerCase();
  if (s.includes("non")) return "non-eu"; // "Non-EU / EFTA"
  if (s.includes("eu")) return "eu"; // "EU / EFTA"
  return null; // unknown -> no filter
}

export type RetrievedChunk = {
  text: string;
  title: string;
  url: string;
  topic: string;
  authority: string;
  score: number;
  /** Set when the passage is from one university's own pages. */
  institution?: string | null;
};

/** The host university a profile names, when HelvetiStart has that university's own pages. */
export function institutionFor(university?: unknown): Institution | null {
  if (university === "Bern University of Applied Sciences") return "bfh";
  if (university === "University of Bern") return "unibe";
  return null; // another institution -> no filter
}

type ChunkRow = {
  title: string;
  url: string;
  topic: string;
  applies_to: string;
  authority: string;
  institution: string | null;
  text: string;
  embedding: string;
};

type LoadedChunk = Omit<ChunkRow, "embedding"> & {
  vector: Float32Array;
  norm: number;
  /** Word counts for keyword search. */
  terms: Map<string, number>;
  length: number;
};

// --- Keyword search (BM25), switched off by default -----------------------------
// Meaning-based search finds passages that say the same thing in other words
// (or another language), but it can rank a passage with the exact term
// ("Form A", "EHIC") below a vaguely related one. Keyword search is the
// opposite, and merging the two rankings is a common way to get both.
//
// It was measured here (npm run eval:retrieval, Nov 2026) and made results
// slightly WORSE: 21/22 questions answered from the top 3 instead of 22/22,
// and fewer of the top passages from a right source (65% vs 76%). Students ask
// in English and many of the best sources are German, which keywords can't
// match, so weaker English passages were pushed up. It stays in the code,
// off, so the test can be repeated when the sources or the questions change.
const STOPWORDS = new Set(
  "the and for with that this from are was were you your can may must not have has will when what how who which about into than then they their there been being also such per der die das und oder mit von für auf ist sind ein eine einer einem einen den dem des sie ihr ihre nicht auch bei aus nach wie wenn dass als zum zur".split(" "),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

function countTerms(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

// How many chunks contain each word, and the average chunk length (set with the cache).
let documentFrequency = new Map<string, number>();
let averageLength = 1;

function bm25(queryTerms: string[], chunk: LoadedChunk, total: number): number {
  const K1 = 1.2;
  const B = 0.75;
  let score = 0;
  for (const term of queryTerms) {
    const tf = chunk.terms.get(term);
    if (!tf) continue;
    const df = documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
    score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * chunk.length) / averageLength));
  }
  return score;
}

// How much the keyword ranking counts next to the meaning ranking (0 = off).
const LEXICAL_WEIGHT = Number(process.env.RETRIEVAL_LEXICAL_WEIGHT ?? 0);
// Reciprocal rank fusion: a passage's score is 1 / (RRF_K + its rank) in each ranking.
const RRF_K = 60;

// Parsing every vector out of SQLite on each search was the slow part of
// retrieval, so chunks are loaded once and kept in memory until the next ingest.
let chunkCache: LoadedChunk[] | null = null;

// Search results for queries seen before. A plan's step queries are the same
// for every student in the same situation, so they are answered from here.
// Emptied at every ingest.
const SEARCH_MEMO_SIZE = 2000;
const searchMemo = new Map<string, RetrievedChunk[]>();

function loadChunks(
  audience: "eu" | "non-eu" | null,
  institution: Institution | null = null,
): LoadedChunk[] {
  if (!chunkCache) {
    const rows = db
      .prepare(
        `SELECT title, url, topic, applies_to, authority, institution, text, embedding
           FROM kb_chunks WHERE embed_model = ? ORDER BY source_id, chunk_index`,
      )
      .all(EMBED_MODEL) as ChunkRow[];
    chunkCache = rows.map(({ embedding, ...r }) => {
      const vector = Float32Array.from(JSON.parse(embedding) as number[]);
      const tokens = tokenize(`${r.title} ${r.text}`);
      return { ...r, vector, norm: norm(vector), terms: countTerms(tokens), length: tokens.length };
    });
    documentFrequency = new Map();
    for (const c of chunkCache) {
      for (const term of c.terms.keys()) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
    averageLength =
      chunkCache.reduce((sum, c) => sum + c.length, 0) / Math.max(chunkCache.length, 1);
  }
  return chunkCache.filter(
    (c) =>
      (!audience || c.applies_to === "all" || c.applies_to === audience) &&
      // A university's own pages are only for its own students.
      (!c.institution || !institution || c.institution === institution),
  );
}

// The plan's theme queries repeat for every student in the same situation, so
// their vectors are worth remembering. Oldest entries are dropped first.
const QUERY_CACHE_SIZE = 500;
const queryCache = new Map<string, number[]>();

async function embedQueries(queries: string[]): Promise<number[][]> {
  const missing = [...new Set(queries.filter((q) => !queryCache.has(q)))];
  const vectors = await embedMany(missing, "query");
  missing.forEach((q, i) => queryCache.set(q, vectors[i]));
  while (queryCache.size > QUERY_CACHE_SIZE) {
    queryCache.delete(queryCache.keys().next().value!);
  }
  return queries.map((q) => queryCache.get(q)!);
}

/** Return the top-k most relevant chunks for a query, filtered by audience. */
export async function retrieve(
  query: string,
  opts: { status?: string; k?: number; institution?: Institution | null } = {},
): Promise<RetrievedChunk[]> {
  return retrieveMany([query], { ...opts, kPerQuery: opts.k ?? 6 });
}

/** Identifies a chunk across queries, for removing duplicates. */
export const chunkKey = (c: { url: string; text: string }) => `${c.url}#${c.text.slice(0, 40)}`;

const toRetrieved = (c: LoadedChunk, score: number): RetrievedChunk => ({
  text: c.text,
  title: c.title,
  url: c.url,
  topic: c.topic,
  authority: c.authority,
  score,
  institution: c.institution,
});

/**
 * Top-k chunks for each query separately (one list per query, best first).
 * `topics` limits a query to sources with those topics; coordinator notes are
 * always allowed, and if nothing matches the filter, every source is used.
 */
export async function retrievePerQuery(
  queries: { query: string; topics?: string[] }[],
  opts: { status?: string; k?: number; institution?: Institution | null } = {},
): Promise<RetrievedChunk[][]> {
  const audience = audienceFor(opts.status);
  const memoKey = (q: { query: string; topics?: string[] }) =>
    JSON.stringify([audience, opts.institution ?? null, opts.k ?? 3, q.query, q.topics ?? []]);
  if (queries.every((q) => searchMemo.has(memoKey(q)))) {
    return queries.map((q) => searchMemo.get(memoKey(q))!);
  }
  const chunks = loadChunks(audience, opts.institution ?? null);
  if (chunks.length === 0) return queries.map(() => []);
  const qvecs = await embedQueries(queries.map((q) => q.query));
  const total = chunkCache?.length ?? chunks.length;
  const results = queries.map(({ query, topics }, qi) => {
    const allowed = topics?.length
      ? chunks.filter((c) => c.authority === "coordinator" || topics.includes(c.topic))
      : chunks;
    const pool = allowed.length > 0 ? allowed : chunks;
    const qvec = qvecs[qi];
    const qnorm = norm(qvec);
    const byMeaning = pool
      .map((c) => ({ c, score: cosineSimilarity(qvec, qnorm, c.vector, c.norm) }))
      .sort((a, b) => b.score - a.score);
    // Merge the meaning ranking with the keyword ranking (see LEXICAL_WEIGHT).
    const fused = new Map<LoadedChunk, number>();
    byMeaning.forEach(({ c }, rank) => fused.set(c, 1 / (RRF_K + rank + 1)));
    if (LEXICAL_WEIGHT > 0) {
      const terms = [...new Set(tokenize(query))];
      pool
        .map((c) => ({ c, score: bm25(terms, c, total) }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score)
        .forEach(({ c }, rank) =>
          fused.set(c, (fused.get(c) ?? 0) + LEXICAL_WEIGHT / (RRF_K + rank + 1)),
        );
    }
    return byMeaning
      .sort((a, b) => fused.get(b.c)! - fused.get(a.c)!)
      .slice(0, opts.k ?? 3)
      // `score` stays the meaning similarity (0-1), which is comparable across queries.
      .map(({ c, score }) => toRetrieved(c, score));
  });
  queries.forEach((q, i) => searchMemo.set(memoKey(q), results[i]));
  while (searchMemo.size > SEARCH_MEMO_SIZE) searchMemo.delete(searchMemo.keys().next().value!);
  return results;
}

/**
 * Retrieve for several queries at once (e.g. one per relocation theme) and
 * merge the results without duplicates. This gives the model balanced coverage
 * of every theme instead of whatever one broad query happens to favour.
 */
export async function retrieveMany(
  queries: string[],
  opts: {
    status?: string;
    kPerQuery?: number;
    maxTotal?: number;
    institution?: Institution | null;
  } = {},
): Promise<RetrievedChunk[]> {
  const kPerQuery = opts.kPerQuery ?? 3;
  const ranked = await retrievePerQuery(
    queries.map((query) => ({ query })),
    { status: opts.status, k: kPerQuery, institution: opts.institution },
  );

  // Take every query's best chunk, then every query's second best, and so on,
  // so a total cap trims all themes evenly instead of dropping the last ones.
  const maxTotal = opts.maxTotal ?? Infinity;
  const picked = new Map<string, RetrievedChunk & { order: number }>();
  for (let rank = 0; rank < kPerQuery && picked.size < maxTotal; rank++) {
    ranked.forEach((hits, qi) => {
      const hit = hits[rank];
      if (!hit || picked.size >= maxTotal) return;
      const key = chunkKey(hit);
      if (picked.has(key)) return;
      picked.set(key, { ...hit, order: qi * kPerQuery + rank });
    });
  }

  // Keep each theme's evidence together in the prompt.
  return [...picked.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...chunk }) => chunk);
}

export function kbStatus() {
  const { chunks, sources } = db
    .prepare(
      "SELECT COUNT(*) AS chunks, COUNT(DISTINCT source_id) AS sources FROM kb_chunks WHERE embed_model = ?",
    )
    .get(EMBED_MODEL) as { chunks: number; sources: number };
  // Chunks embedded with a different model are ignored until the next ingest.
  const stale = (
    db.prepare("SELECT COUNT(*) AS n FROM kb_chunks WHERE embed_model != ?").get(EMBED_MODEL) as {
      n: number;
    }
  ).n;
  const { lastChecked } = db
    .prepare("SELECT MAX(checked_at) AS lastChecked FROM kb_sources")
    .get() as { lastChecked: string | null };
  return { chunks, sources, ready: chunks > 0, embedModel: EMBED_MODEL, stale, lastChecked };
}
