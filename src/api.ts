// Small client for talking to the HelvetiStart backend (server/): login + profile,
// and the local-AI features (plan, chat, completion feedback). The server
// caches generated plans by their inputs so an unchanged profile loads instantly.

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3001";

export type ApiProfile = {
  email: string;
  firstName: string;
  nationality: string;
  age: string;
  status: string;
  university: string;
  degree: string;
  canton: string;
  arrival: string;
  stayLength: string;
  municipality: string;
  housingStatus: string;
  plansToWork: string;
  healthCoverage: string;
};

export type User = { id: number; email: string };

/** Ask the server which citizenship group a nationality belongs to. */
export async function classifyCitizenship(
  nationality: string,
): Promise<Citizenship> {
  const res = await fetch(`${API_BASE}/api/citizenship/classify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nationality }),
  });
  if (!res.ok) throw new Error("Could not check citizenship.");
  return (await res.json()) as Citizenship;
}

/** Sign in with an email. Creates the user on first sign-in. */
export async function login(email: string): Promise<User> {
  const res = await fetch(`${API_BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? "Could not sign in. Is the backend running?");
  }
  const data = (await res.json()) as { user: User };
  return data.user;
}

/** Load a saved profile, or null if the user has not filled one in yet. */
export async function getProfile(userId: number): Promise<ApiProfile | null> {
  const res = await fetch(`${API_BASE}/api/profile/${userId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Could not load your saved details.");
  const data = (await res.json()) as { profile: ApiProfile };
  return data.profile;
}

export type Citizenship = { group: string; country: string | null };

/** What the server has stored for this user, plus how it classified their citizenship. */
export async function getProfileDetails(
  userId: number,
): Promise<{ profile: ApiProfile; citizenship: Citizenship } | null> {
  const res = await fetch(`${API_BASE}/api/profile/${userId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Could not load your saved details.");
  return (await res.json()) as { profile: ApiProfile; citizenship: Citizenship };
}

/** Create or update the saved profile. */
export async function saveProfile(userId: number, profile: ApiProfile): Promise<void> {
  const res = await fetch(`${API_BASE}/api/profile/${userId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  if (!res.ok) throw new Error("Could not save your details.");
}

// --- Session: remember the signed-in user so the login can be reused ---------
// Stored in the browser's localStorage so it survives refreshes and restarts.
const SESSION_KEY = "helvetistart.session";

export function loadSession(): User | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export function saveSession(user: User): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  } catch {
    // ignore storage errors (e.g. private browsing)
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

// --- AI features (all served by the LOCAL model) ----------------------------

/** A source page behind an answer; `refs` are all the [n] numbers that point to it. */
export type AssistantSource = { n: number; refs?: number[]; title: string; url: string };

export type PlanStop = {
  phase?: string;
  title?: string;
  why?: string;
  personalisedBecause?: string;
  deadline?: string;
  time?: string;
  documents?: string[];
  sourceUrl?: string;
  sourceTitle?: string;
  formId?: string;
  formUrl?: string;
  formLabel?: string;
  formLang?: string;
  /** True while the AI is still writing this stop's details. */
  pending?: boolean;
};

export type Plan = {
  stops: PlanStop[];
  sources: AssistantSource[];
  /** Set when no plan could be generated (e.g. citizenship group not supported yet). */
  note?: string;
  unsupported?: boolean;
};

/** Have the server load the local models now, so the plan isn't also waiting on that. */
export function warmUpModels(): void {
  fetch(`${API_BASE}/api/warmup`, { method: "POST" }).catch(() => {
    // backend not running — the plan request will report it
  });
}

type PlanEvent =
  | { type: "plan"; stops: PlanStop[] }
  | { type: "step"; index: number; stop: PlanStop }
  | { type: "done"; plan: Partial<Plan> | null }
  | { type: "error"; error: string };

/**
 * Build the personalised, source-grounded plan. The server sends it as it is
 * made: every stop at once (what to do, why it's in this plan, its form), then
 * each stop's details as the local AI finishes writing them. `onUpdate` is
 * called with the plan so far each time, so the app can show it straight away.
 */
export async function generatePlan(
  profile: Partial<ApiProfile>,
  onUpdate?: (plan: Plan) => void,
): Promise<Plan> {
  const res = await fetch(`${API_BASE}/api/plan/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile }),
  });
  if (!res.ok || !res.body) throw new Error("Could not generate your plan.");

  let plan: Plan = { stops: [], sources: [] };
  let failed = false;
  const handle = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as PlanEvent;
    if (event.type === "error") {
      failed = true;
      return;
    }
    if (event.type === "plan") {
      plan = { ...plan, stops: event.stops };
    } else if (event.type === "step") {
      plan = { ...plan, stops: plan.stops.map((s, i) => (i === event.index ? event.stop : s)) };
    } else {
      plan = {
        stops: Array.isArray(event.plan?.stops) ? event.plan.stops : [],
        sources: event.plan?.sources ?? [],
        note: event.plan?.note,
        unsupported: event.plan?.unsupported,
      };
    }
    onUpdate?.(plan);
  };

  // One JSON object per line.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    lines.forEach(handle);
  }
  handle(buffered + decoder.decode());

  if (failed && plan.stops.length === 0) throw new Error("Could not generate your plan.");
  // If the stream stopped early, no stop is left looking as if it's still being written.
  return { ...plan, stops: plan.stops.map(({ pending: _pending, ...stop }) => stop) };
}

export type ChatMessage = {
  role: "user" | "ai";
  text: string;
  sources?: AssistantSource[];
  /** File names of the documents sent along with a user message. */
  attachments?: string[];
};

/**
 * Ask the local AI assistant a question, grounded in official sources. When
 * signed in, the server remembers the conversation; otherwise the recent
 * messages are sent along so follow-up questions still make sense.
 */
export async function askAssistant(
  profile: Partial<ApiProfile>,
  question: string,
  userId: number | null,
  history: ChatMessage[],
  /** Aborting it stops the answer: the server stops the model too. */
  signal?: AbortSignal,
  /** Documents attached to this question (already read): the answer is about them. */
  documentIds: number[] = [],
): Promise<{ answer: string; sources: AssistantSource[] }> {
  const res = await fetch(`${API_BASE}/api/assistant`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profile,
      question,
      userId,
      documentIds,
      history: history.map(({ role, text }) => ({ role, text })),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    answer?: string;
    sources?: AssistantSource[];
    error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? "The assistant is unavailable.");
  return { answer: data.answer ?? "", sources: data.sources ?? [] };
}

/** How complete the knowledge base is, and when its sources were last checked. */
export async function getKbStatus(): Promise<{ ready: boolean; lastChecked: string | null }> {
  const res = await fetch(`${API_BASE}/api/kb/status`);
  if (!res.ok) throw new Error("Could not load the source status.");
  return (await res.json()) as { ready: boolean; lastChecked: string | null };
}

/** The saved conversation with the assistant, oldest first. */
export async function getChatHistory(userId: number): Promise<ChatMessage[]> {
  const res = await fetch(`${API_BASE}/api/chat/${userId}`);
  if (!res.ok) throw new Error("Could not load your conversation.");
  const data = (await res.json()) as { messages?: ChatMessage[] };
  return data.messages ?? [];
}

/** Forget the conversation with the assistant. */
export async function clearChatHistory(userId: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/chat/${userId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Could not clear your conversation.");
}

/** When a stop is completed, get a short note / recalculation from the AI. */
export async function getStopFeedback(
  profile: Partial<ApiProfile>,
  completedTitle: string,
  remaining: string[],
): Promise<string> {
  const res = await fetch(`${API_BASE}/api/plan/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile, completedTitle, remaining }),
  });
  const data = (await res.json().catch(() => ({}))) as { feedback?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not get feedback.");
  return data.feedback ?? "";
}

// --- Uploaded documents (read and summarised by the LOCAL models) ------------

export type KeyDetail = { label: string; value: string };

export type UploadedDocument = {
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

/** File types that can be uploaded (other image formats are converted to JPEG first). */
export const DOCUMENT_ACCEPT =
  ".pdf,.png,.jpg,.jpeg,.webp,.heic,.heif,.gif,.txt,.md,.csv,application/pdf,image/*,text/plain";
export const MAX_DOCUMENT_MB = 15;

// Photos are sent as JPEG on a white background, at most this many pixels on
// the long side: transparent PNGs otherwise read as black, and full-size phone
// photos only make the local vision model slower.
const MAX_IMAGE_SIDE = 2000;

async function prepareImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file; // this browser can't decode it; the server explains what's supported
  }
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d");
  if (!context) return file;
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  // Keep the original name so the student recognises the file.
  return blob ? new File([blob], file.name, { type: "image/jpeg" }) : file;
}

/** The student's uploaded documents, newest first. */
export async function listDocuments(userId: number): Promise<UploadedDocument[]> {
  const res = await fetch(`${API_BASE}/api/documents/${userId}`);
  if (!res.ok) throw new Error("Could not load your documents.");
  const data = (await res.json()) as { documents?: UploadedDocument[] };
  return data.documents ?? [];
}

/** Upload a file. The server reads it in the background (status "processing"). */
export async function uploadDocument(userId: number, original: File): Promise<UploadedDocument> {
  const file = await prepareImage(original);
  if (file.size > MAX_DOCUMENT_MB * 1024 * 1024) {
    throw new Error(`${file.name} is too large. The limit is ${MAX_DOCUMENT_MB} MB.`);
  }
  const res = await fetch(`${API_BASE}/api/documents/${userId}`, {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Filename": encodeURIComponent(file.name),
    },
    body: file,
  });
  const data = (await res.json().catch(() => ({}))) as { document?: UploadedDocument; error?: string };
  if (!res.ok || !data.document) throw new Error(data.error ?? `Could not upload ${file.name}.`);
  return data.document;
}

/**
 * Wait until the server has finished reading these documents (it starts as soon
 * as they are uploaded), then return them: each is "ready" or "failed".
 */
export async function waitForDocuments(
  userId: number,
  ids: number[],
  signal?: AbortSignal,
): Promise<UploadedDocument[]> {
  const stopped = () => new DOMException("Stopped", "AbortError");
  for (;;) {
    if (signal?.aborted) throw stopped();
    const mine = (await listDocuments(userId)).filter((document) => ids.includes(document.id));
    if (mine.every((document) => document.status !== "processing")) return mine;
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, 1000);
      signal?.addEventListener(
        "abort",
        () => {
          window.clearTimeout(timer);
          reject(stopped());
        },
        { once: true },
      );
    });
  }
}

/** Delete an uploaded document and everything read from it. */
export async function deleteDocument(userId: number, documentId: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/documents/${userId}/${documentId}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error("Could not delete the document.");
}
