"use client";
// 🧠 Agent trace: short-term and long-term memory side by side with the raw database rows.
// A live stream (server-sent events) of every step the brain takes keeps them fresh: memory is
// read again after each step that can change it (at most every 300 ms).
import { useEffect, useRef, useState } from "react";
import { api, traceSource, userPath, type TraceEvent } from "@/lib/api";
import { short } from "@/lib/util";

type Item = { key: string; text: string; category: string; subject?: string; pinned?: boolean; expires_at?: string; asked?: boolean };
type MemoryState = {
  short_term: {
    conversation: { thread: string; summary: string; summarized_count: number; started_at: string } | null;
    total: number;
    working_memory: Item[];
    messages: { role: string; content: string; where: string }[];
  };
  long_term: { memories: Item[]; pending: Item[] };
  rules: { window: number; summarize_after: number; auto_memory: boolean; memory_in_prompt: number; memory_backend: string };
};
type Raw = { rows: Record<string, unknown[]>; schema: Record<string, unknown> };

const MEMORY_EVENTS = new Set(["context", "tool_result", "turn_end", "memory_extract", "summary", "response"]);

const Badge = ({ text, cls = "" }: { text: string; cls?: string }) => <span className={"badge " + cls}>{text}</span>;

export function TracePanel({ user, thread, refreshKey, onClose }: { user: string; thread: string; refreshKey: number; onClose: () => void }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [state, setState] = useState<MemoryState | null>(null);
  const [raw, setRaw] = useState<Raw | null>(null);
  const [error, setError] = useState("");
  const [inPrompt, setInPrompt] = useState<Set<string>>(new Set());     // memory keys in the latest prompt ("context" event)
  const [decisions, setDecisions] = useState<Set<string>>(new Set());   // memory keys changed by the latest extraction
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current = true;
    const render = async () => {
      try {
        const memory = await api<MemoryState>(`${userPath(user)}/memory/state?thread=${thread}`);
        const rows = await api<Raw>(`${userPath(user)}/memory/raw?thread=${thread}`);
        if (current) { setState(memory); setRaw(rows); setError(""); }
      } catch (err) { if (current) setError((err as Error).message); }
    };
    const refresh = () => { clearTimeout(timer); timer = setTimeout(render, 300); };
    refreshRef.current = refresh;
    render();
    const source = traceSource(user);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as TraceEvent;
        const d = event.data || {};
        if (event.kind === "context") setInPrompt(new Set(((d.long_term || []) as { key: string }[]).map((m) => m.key)));
        if (event.kind === "memory_extract") {
          setDecisions(new Set((d.items as { decision: string; key: string }[]).filter((i) => i.decision !== "ignore").map((i) => i.key)));
        }
        if (MEMORY_EVENTS.has(event.kind)) refresh();
      } catch { /* skip a bad event */ }
    };
    return () => { current = false; clearTimeout(timer); source.close(); };
  }, [user, thread]);

  // Something changed outside the trace (a clear button, an edit): read memory again.
  useEffect(() => { if (refreshKey) refreshRef.current(); }, [refreshKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const memoryBox = (item: Item, extra?: React.ReactNode) => (
    <div key={item.key} className={"mem" + (decisions.has(item.key) ? " changed" : "")}>
      <div className="k">
        <Badge text={item.category} />
        {item.pinned && <Badge text="pinned" cls="prompt" />}
        {item.subject || item.key}
        {item.expires_at && `until ${new Date(item.expires_at).toLocaleDateString()}`}
        {inPrompt.has(item.key) && <Badge text="in last prompt" cls="prompt" />}
        {extra}
      </div>
      <div>{item.text}</div>
    </div>
  );

  const st = state?.short_term, lt = state?.long_term, r = state?.rules;
  const byKind: Record<string, Item[]> = {};
  for (const item of lt?.memories || []) (byKind[item.category] ||= []).push(item);

  return (
    <section className="trace-panel on" aria-label="Agent trace">
      <div className="trace-head">
        <h2>🧠 Agent trace</h2>
        <span className="status">
          <span className={"live-dot" + (connected ? " on" : "")} />{" "}
          {connected === null ? "connecting…" : connected ? `live · user “${user}”` : "reconnecting…"}
        </span>
        <span className="grow" />
        <button type="button" onClick={onClose}>✕ Close</button>
      </div>
      <div className="trace-cols">
        <div className="trace-col">
          <h3>Short-term memory</h3>
          {error ? "Could not load memory: " + error : st && r && (
            <>
              <div className="note">{`How it works: the last ${r.window} messages go to the LLM word for word (green). When more than ${r.summarize_after} messages are not yet summarized, the older ones are folded into a running summary (orange) in the background. Nothing is deleted; folded messages just stop being sent. A thread never resets: your main thread is one ongoing chat, and “New conversation” opens a separate thread. Short-term memory (said with “short term”, or clearly temporary) expires after 10 days.`}</div>
              {!st.conversation ? <div className="empty">No conversation yet.</div> : (
                <>
                  <h3>{`This thread (${st.conversation.thread})`}</h3>
                  <div className="sub">{`${st.total} messages · ${st.conversation.summarized_count} folded into the summary · started ${new Date(st.conversation.started_at).toLocaleString()}`}</div>
                  <h3>Running summary</h3>
                  {st.conversation.summary ? <pre>{st.conversation.summary}</pre> : <div className="empty">No summary yet (the chat is still short).</div>}
                  <h3>Short-term memory (10 days)</h3>
                  {!st.working_memory.length && <div className="empty">Nothing coming up.</div>}
                  {st.working_memory.map((item) => memoryBox(item))}
                  <h3>Message window</h3>
                  <div className="sub"><Badge text="in window" cls="window" /> sent to the LLM  <Badge text="in summary" cls="summary" /> folded  <Badge text="stored" cls="stored" /> only in the database</div>
                  {st.messages.slice().reverse().map((m, i) => (
                    <div key={i} className={"msg " + m.where}><Badge text={m.role === "user" ? "you" : "Umbrella"} /> {short(m.content, 200)}</div>
                  ))}
                </>
              )}
            </>
          )}
        </div>
        <div className="trace-col">
          <h3>Long-term memory</h3>
          {lt && r && (
            <>
              <div className="note">{`How it works: Umbrella saves only when you ask (“remember long term …”, “short term …”); the automatic extractor is ${r.auto_memory ? "on" : "off"}. The same category, subject and topic update the old item instead of adding a new one. Only pinned profile facts (at most ${r.memory_in_prompt}) go with every message; everything else is fetched with the find_saved tool when you ask. Store: ${r.memory_backend}.`}</div>
              <h3>{`Saved (${lt.memories.length})`}</h3>
              {!lt.memories.length && <div className="empty">Nothing yet.</div>}
              {Object.entries(byKind).map(([kind, items]) => (
                <div key={kind}><div className="sub">{kind}</div>{items.map((item) => memoryBox(item))}</div>
              ))}
              <h3>{`Unsure: ask the user (${lt.pending.length})`}</h3>
              {!lt.pending.length && <div className="empty">None.</div>}
              {lt.pending.map((item) => memoryBox(item, <Badge text={item.asked ? "asked" : "will ask"} cls="ask" />))}
            </>
          )}
        </div>
        <div className="trace-col">
          <h3>Memory objects (DB)</h3>
          <div className="note">Exactly what is stored in Postgres for this user: each table&apos;s schema and its rows (long-term = <code>memories</code>; short-term = <code>conversations</code> + <code>messages</code>).</div>
          {raw && Object.entries(raw.rows).map(([table, rows]) => {
            const name = table.split(" ")[0];
            return (
              <details key={table} open={name === "memories"}>
                <summary>{`${table} · ${rows.length} rows`}</summary>
                <div className="obj-label">schema</div>
                <div className="obj">{JSON.stringify(raw.schema[name] || [], null, 2)}</div>
                <div className="obj-label">rows</div>
                <div className="obj">{JSON.stringify(rows, null, 2)}</div>
              </details>
            );
          })}
        </div>
      </div>
    </section>
  );
}
