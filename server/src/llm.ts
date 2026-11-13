// Thin client for the LOCAL language model, served by Ollama on this machine.
// No external AI service is contacted — only http://localhost:11434.
// The model is configurable so we can swap Qwen3 <-> Apertus with one env var.

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
export const LLM_MODEL = process.env.OLLAMA_MODEL ?? "qwen3:8b";
// Model for extracting key facts at ingest. Ingest runs rarely, so a larger,
// slower model is affordable here (e.g. EXTRACT_MODEL=qwen3:14b).
export const EXTRACT_MODEL = process.env.EXTRACT_MODEL ?? LLM_MODEL;
// bge-m3 is multilingual: English questions match the German Bern pages and forms.
// Changing this needs a re-ingest; chunks from another model are ignored until then.
export const EMBED_MODEL = process.env.EMBED_MODEL ?? "bge-m3";
// Vision model that reads photos and screenshots of documents the student uploads.
export const VISION_MODEL = process.env.VISION_MODEL ?? "qwen3-vl:8b";
// How long Ollama keeps a model in memory after a request. Loading one takes
// seconds, so keep both models warm between students.
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? "30m";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Base64-encoded images (PNG/JPEG), for a vision model. */
  images?: string[];
  /** On an assistant message: the tools the model asked to run. */
  tool_calls?: ToolCall[];
  /** On a tool message: which tool this result came from. */
  tool_name?: string;
};

/** A tool the model asks the server to run (it never runs anything itself). */
export type ToolCall = { function: { name: string; arguments: Record<string, unknown> } };

/** A tool as described to the model: a name, when to use it, and its arguments. */
export type ToolSpec = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

/** Is the local Ollama server reachable? */
export async function llmAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

/** Reasoning models (Qwen3, Apertus) emit <think>...</think> — hide it from users. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

// Context window for the local model. Ollama's default is small and silently
// truncates long prompts, so we set it explicitly (fits comfortably in 16 GB).
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 12288);
// Qwen3's hidden "thinking" pass is slow on a laptop; off unless enabled.
const THINK = process.env.OLLAMA_THINK === "true";

type ChatOptions = {
    temperature?: number;
    format?: Record<string, unknown>;
    think?: boolean;
    model?: string;
    /** Override how long the model stays loaded (e.g. "1m" for the rarely used vision model). */
    keepAlive?: string;
    /** Most tokens to generate: guards against a model stuck repeating itself. */
    maxTokens?: number;
    /** Above 1 discourages repeating the same text (Ollama's repeat_penalty). */
    repeatPenalty?: number;
    /** Tools the model may ask for (see tools.ts). Only chatTurn reports the requests. */
    tools?: ToolSpec[];
    /** Aborting it stops the model mid-answer (Ollama stops when the request is dropped). */
    signal?: AbortSignal;
};

/** Send a chat completion to the local model and return the text reply. */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  return (await chatTurn(messages, opts)).content;
}

/**
 * One turn of the model: its text, plus any tools it asked to run. The caller
 * runs them and sends the results back in a further turn.
 */
export async function chatTurn(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model ?? LLM_MODEL,
      messages,
      // Streamed, so the response starts at once: Node's fetch gives up after
      // 5 minutes without one, which long reasoning passes exceeded.
      stream: true,
      think: opts.think ?? THINK,
      keep_alive: opts.keepAlive ?? KEEP_ALIVE,
      // A JSON schema here forces the reply into exactly that structure.
      ...(opts.format ? { format: opts.format } : {}),
      ...(opts.tools?.length ? { tools: opts.tools } : {}),
      options: {
        temperature: opts.temperature ?? 0.2,
        num_ctx: NUM_CTX,
        ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}),
        ...(opts.repeatPenalty ? { repeat_penalty: opts.repeatPenalty } : {}),
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Local LLM error ${res.status}: ${detail || "is Ollama running and the model pulled?"}`,
    );
  }

  // Ollama streams one JSON object per line; the reply is the joined content
  // (the reasoning, if any, arrives separately and is left out).
  let reply = "";
  const toolCalls: ToolCall[] = [];
  let buffered = "";
  const decoder = new TextDecoder();
  const read = (line: string) => {
    if (!line.trim()) return;
    const part = JSON.parse(line) as {
      message?: { content?: string; tool_calls?: ToolCall[] };
      error?: string;
    };
    if (part.error) throw new Error(`Local LLM error: ${part.error}`);
    reply += part.message?.content ?? "";
    toolCalls.push(...(part.message?.tool_calls ?? []));
  };
  for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(bytes, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    lines.forEach(read);
  }
  read(buffered + decoder.decode());
  return { content: reply, toolCalls };
}

// nomic-embed-text was trained with task prefixes and matches noticeably worse
// without them. bge-m3 and most other models take plain text.
function withTaskPrefix(text: string, kind: "query" | "document"): string {
  if (!EMBED_MODEL.startsWith("nomic-embed")) return text;
  return `${kind === "query" ? "search_query" : "search_document"}: ${text}`;
}

/** Embed several texts in ONE request (much faster than one call per text). */
export async function embedMany(texts: string[], kind: "query" | "document"): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: texts.map((t) => withTaskPrefix(t, kind)),
      keep_alive: KEEP_ALIVE,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Embedding error ${res.status}: ${detail || `is the "${EMBED_MODEL}" model pulled?`}`,
    );
  }
  const data = (await res.json()) as { embeddings?: number[][] };
  const vectors = data.embeddings ?? [];
  if (vectors.length !== texts.length || vectors.some((v) => v.length === 0)) {
    throw new Error("Embedding response had missing vectors.");
  }
  return vectors;
}

/** Embed a piece of text into a vector, using the local embedding model. */
export async function embed(text: string, kind: "query" | "document"): Promise<number[]> {
  return (await embedMany([text], kind))[0];
}

/**
 * Load both models into memory ahead of time, so the first plan or chat answer
 * doesn't also pay for loading them. An empty chat request only loads the model.
 * It must use the same num_ctx as chat(): Ollama reloads a model when it changes.
 */
export async function warmUp(): Promise<void> {
  await Promise.all([
    fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [],
        keep_alive: KEEP_ALIVE,
        options: { num_ctx: NUM_CTX },
      }),
    }),
    embed("warm-up", "query"),
  ]);
}
