// Talking to the companion server (companion-umbrella, `python -m companion.server`) over HTTP.
// Plain JSON calls, POST responses streamed as server-sent events, and EventSource for the live trace.

export const COMPANION_URL = (process.env.NEXT_PUBLIC_COMPANION_URL || "http://127.0.0.1:8300").replace(/\/$/, "");

export const companionUrl = (path: string) => COMPANION_URL + path;

export async function api<T = Record<string, unknown>>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(companionUrl(path), { headers: { "Content-Type": "application/json" }, ...options });
  if (!response.ok) throw new Error(response.status + " " + (await response.text()).slice(0, 200));
  return response.json() as Promise<T>;
}

export const postJson = <T = Record<string, unknown>>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

// The server answers with server-sent events over a POST response: read them as they arrive.
// Each event is one JSON object on a "data:" line, events end with a blank line.
export async function streamPost<E = StreamEvent>(path: string, options: RequestInit, onEvent: (event: E) => void): Promise<void> {
  const response = await fetch(companionUrl(path), options);
  if (!response.ok) throw new Error(response.status + " " + (await response.text()).slice(0, 200));
  if (!response.body) throw new Error("the server sent no stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      for (const line of chunk.split("\n")) if (line.startsWith("data:")) onEvent(JSON.parse(line.slice(5)) as E);
    }
  }
}

// The live trace of one user (every step the brain takes), as server-sent events.
export const traceSource = (userId: string) => new EventSource(companionUrl(`/v1/users/${encodeURIComponent(userId)}/trace`));

export const userPath = (userId: string) => `/v1/users/${encodeURIComponent(userId)}`;

// --- Shapes the server sends ---------------------------------------------------------------------

export type UsageCall = { provider: string; input: number; output: number; reasoning: number; reported: boolean };
export type Usage = { input: number; output: number; reasoning: number; total: number; calls: UsageCall[] };

export type Reply = {
  text: string;
  expression: string;
  tools_used?: string[];
  sources?: string[];
  provider?: string;
  ms?: number;
  usage?: Usage;
  db_changes?: unknown[];
};

export type VoiceCues = { speech_s?: number; wpm?: number; pause_before_s?: number | null; interrupted?: boolean };

export type HeardTurn = {
  heard: string;
  language?: string;
  kept: boolean;
  reason?: string;
  stt_provider: string;
  stt_ms: number;
  voice_cues?: VoiceCues | null;
  voice_note?: string;
};

export type StreamEvent =
  | { type: "request" | "response"; object: unknown }
  | { type: "delta"; text: string }
  | { type: "expression"; expression: string }
  | { type: "done"; reply: Reply | null }
  | { type: "heard"; turn: HeardTurn }
  | { type: "audio"; wav_b64: string; tts_provider: string }
  | { type: "error"; error: string };

export type Health = { ok: boolean; name: string; tools: string[]; stt: string[]; tts: string[]; live: boolean; plugins: string[] };

export type TraceEvent = { kind: string; turn: string; user_id: string; at: number; data: Record<string, unknown> };
