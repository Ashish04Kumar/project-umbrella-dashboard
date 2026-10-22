"use client";
// 🧪 Consumer test: a simulated consumer (another LLM) chats with Umbrella. This panel listens to that
// user's trace and draws each turn: what was said, what went to the LLM, what came back, what the
// tools did, and Umbrella's reply. You can also type a message yourself, as that consumer.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api, postJson, traceSource, type TraceEvent } from "@/lib/api";
import { pretty } from "@/lib/util";

type Step = { key: number; icon: string; title: string; sub?: string; body: ReactNode[]; cls: string };
type Card = { kind: "card"; turn: string; title: string; head: ReactNode[]; steps: Step[]; manual?: boolean };
type FeedItem = { kind: "note"; key: number; text: string } | Card;
type TestStatus = { running?: boolean; user_id?: string; thread?: string; done?: number; turns?: number };

const Pre = ({ text }: { text: unknown }) => <pre>{pretty(text)}</pre>;

function Folded({ label, open = false, children }: { label: string; open?: boolean; children: ReactNode }) {
  return <details open={open}><summary>{label}</summary>{children}</details>;
}

type PromptMessage = { role: string; tool?: string; content?: string; tool_calls?: { name: string; arguments: string }[] };
function PromptView({ messages }: { messages: PromptMessage[] }) {
  return (
    <div>
      {messages.map((m, i) => (
        <div key={i} className="msgline">
          <b>{m.role + (m.tool ? ` (${m.tool})` : "")}</b>
          {m.content && <Pre text={m.content} />}
          {m.tool_calls && <Pre text={m.tool_calls.map((c) => `→ ${c.name}(${c.arguments})`).join("\n")} />}
        </div>
      ))}
    </div>
  );
}

let key = 0;

export function TestPanel({ onClose, onOpenChat }: { onClose: () => void; onOpenChat: (user: string, thread: string) => void }) {
  const [testUser, setTestUser] = useState("consumer1");
  const [turns, setTurns] = useState(30);
  const [gap, setGap] = useState(20);
  const [running, setRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("idle");
  const [thread, setThread] = useState<string | null>(null);
  const [intents, setIntents] = useState<string[]>([]);
  const [covered, setCovered] = useState(0);
  const [ask, setAsk] = useState("");
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const feedBox = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Where the test stands now (it may already be running from before).
  useEffect(() => {
    api<TestStatus>("/v1/test/status").then((s) => {
      setRunning(Boolean(s.running));
      if (s.user_id) { setTestUser(s.user_id); setThread(s.thread || null); }
      if (s.running) setStatus(`running · ${s.done}/${s.turns} turns`);
    }).catch(() => { /* server restarting */ });
  }, []);

  useLayoutEffect(() => {
    const box = feedBox.current;
    if (box && stick.current) box.scrollTop = box.scrollHeight;
  }, [feed]);

  useEffect(() => {
    const note = (text: string) => setFeed((items) => [...items, { kind: "note", key: key++, text }]);
    const card = (items: FeedItem[], turn: string, title = "Turn"): [FeedItem[], Card] => {
      const found = items.find((i): i is Card => i.kind === "card" && i.turn === turn);
      if (found) return [items, found];
      const made: Card = { kind: "card", turn, title, head: [], steps: [] };
      return [[...items, made], made];
    };
    const change = (turn: string, title: string | undefined, fn: (c: Card) => Card) => {
      const box = feedBox.current;
      stick.current = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 400;
      setFeed((items) => {
        const [withCard, found] = card(items, turn, title);
        return withCard.map((i) => (i === found ? fn(found) : i));
      });
    };
    const step = (turn: string, icon: string, title: string, sub = "", body: ReactNode[] = [], cls = "") =>
      change(turn, undefined, (c) => ({ ...c, steps: [...c.steps, { key: key++, icon, title, sub, body, cls }] }));

    const render = (event: TraceEvent) => {
      const d = event.data as Record<string, any>;  // eslint-disable-line @typescript-eslint/no-explicit-any -- trace payloads differ per kind
      const turn = event.turn;
      switch (event.kind) {
        case "sim_start":
          setFeed([{ kind: "note", key: key++, text: `Test started as consumer “${event.user_id}” (${d.turns} turns).` }]);
          setThread(d.thread); setIntents(d.intents || []); setCovered(0);
          break;
        case "sim_message":
          change(turn, `#${d.number}`, (c) => ({
            ...c, title: `#${d.number}`,
            head: [...c.head, <span key="i" className="sub">{d.intent}</span>,
              ...(d.covers_intent ? [] : [<span key="b" className="badge ask">answering Umbrella&apos;s question first</span>])],
          }));
          step(turn, "🧑", "Rohan says", "", [<div key="t">{d.text}</div>], "sim");
          if (d.covers_intent) setCovered((n) => n + 1);
          break;
        case "turn_start":
          // A message that is not the simulated consumer's: one you typed (or sent from the chat).
          setFeed((items) => {
            if (items.some((i) => i.kind === "card" && i.turn === turn)) return items;
            return [...items, { kind: "card", turn, title: "🙋 You", manual: true, head: [<span key="s" className="sub">{"typed by you, as " + event.user_id}</span>],
              steps: [{ key: key++, icon: "🙋", title: "You asked", body: [<div key="t">{d.text}</div>], cls: "you" }] }];
          });
          break;
        case "turn_end":
          setFeed((items) => items.map((i) => (i.kind === "card" && i.turn === turn && i.manual
            ? { ...i, steps: [...i.steps, { key: key++, icon: "💬", title: "Umbrella replies", sub: `${(d.ms / 1000).toFixed(1)} s · tools: ${(d.tools || []).join(", ") || "none"}`, body: [<div key="t">{d.reply}</div>], cls: "reply" }] }
            : i)));
          break;
        case "context":
          step(turn, "🗂️", "Context loaded", `thread ${d.thread} · ${d.history} earlier messages · tool groups: ${(d.groups || []).join(", ")} · about ${d.est_prompt_tokens} prompt tokens`,
            d.long_term && d.long_term.length ? [<div key="p" className="sub">{"Pinned profile in the prompt: " + d.long_term.map((m: { text: string }) => m.text).join("; ")}</div>] : []);
          break;
        case "llm_request":
          step(turn, "📤", `To the LLM (round ${d.round})`, `${d.messages.length} messages · ${d.tools.length} tools offered · tool_choice: ${d.tool_choice}`, [
            <Folded key="t" label="Tools offered"><Pre text={d.tools.join(", ")} /></Folded>,
            <Folded key="m" label="The whole request: system prompt, chat, new message"><PromptView messages={d.messages} /></Folded>,
          ]);
          break;
        case "llm_result": {
          const usage = d.usage && d.usage.total ? ` · ${d.usage.prompt} in / ${d.usage.completion} out tokens` : "";
          const nodes: ReactNode[] = [];
          const calls = d.tool_calls as { name: string; arguments: string }[] | undefined;
          if (calls && calls.length) nodes.push(<Pre key="c" text={calls.map((c) => `${c.name}(${c.arguments})`).join("\n")} />);
          if (d.text) nodes.push(<Pre key="x" text={d.text} />);
          if (d.reasoning) nodes.push(<Folded key="r" label="Model's reasoning"><Pre text={d.reasoning} /></Folded>);
          step(turn, "📥", `From the LLM: ${calls && calls.length ? "tool call" : "text"}`, `${d.provider} · ${d.ms} ms${usage}`, nodes);
          break;
        }
        case "llm_retry":
          step(turn, "🔁", "Messy output, asking again", d.reason, [<Pre key="t" text={d.text || ""} />], "bad");
          break;
        case "llm_error":
          step(turn, "❌", "Every LLM failed", `${d.ms} ms`, [<Pre key="e" text={d.error} />], "bad");
          break;
        case "tool_result": {
          let result = d.result;
          try { result = JSON.stringify(JSON.parse(d.result), null, 2); } catch { /* keep as text */ }
          step(turn, d.ok ? "🔧" : "⚠️", `Tool ${d.name} ${d.ok ? "ran" : "refused"}`, `${d.ms} ms`,
            [<Pre key="a" text={`${d.name}(${d.arguments})`} />, <Folded key="r" label="Result" open><Pre text={result} /></Folded>], d.ok ? "" : "bad");
          break;
        }
        case "db_change":
          step(turn, "🗄️", `DB ${d.op} ${d.table} ${d.id}`, d.row + (d.change ? " · " + d.change : ""));
          break;
        case "code_reply":
          step(turn, "🧩", "Reply written by code from the tool result", "no second LLM call");
          break;
        case "guard":
          if (!String(d.note || "").startsWith("reply checked")) step(turn, "🛡️", "Guard changed the reply", d.note, [], "bad");
          break;
        case "sim_reply":
          step(turn, "💬", "Umbrella replies", `${d.provider || "fallback"} · ${(d.ms / 1000).toFixed(1)} s total · tools: ${(d.tools || []).join(", ") || "none"}`, [<div key="t">{d.text}</div>], "reply");
          setStatus(`turn ${d.number} done`);
          break;
        case "sim_error":
          note("⚠️ " + d.error);
          break;
        case "sim_end":
          note(`Test finished: ${d.done} turns, ${d.intents_covered} of ${d.intents_total} intents covered, ${Math.round(d.seconds / 60)} min.` + (d.error ? " Error: " + d.error : ""));
          setRunning(false);
          setStatus("finished");
          break;
      }
    };

    const source = traceSource(testUser);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => { try { render(JSON.parse(message.data)); } catch (error) { console.error(error); } };
    return () => source.close();
  }, [testUser]);

  const start = async () => {
    setRunning(true);
    try {
      const s = await postJson<TestStatus>("/v1/test/start", { user_id: testUser, turns, gap_seconds: gap });
      setThread(s.thread || null);
      setStatus("running");
    } catch (error) { setStatus("could not start: " + (error as Error).message); setRunning(false); }
  };
  const stop = async () => {
    await postJson("/v1/test/stop");
    setStatus("stopping after this turn…");
  };
  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = ask.trim();
    if (!text) return;
    setAsk("");
    try {
      // Same chat as the test: the trace shows it here; a running test waits for it (one message at a time).
      await postJson("/v1/chat", { user_id: testUser, text });
    } catch (error) { setFeed((items) => [...items, { kind: "note", key: key++, text: "Could not send: " + (error as Error).message }]); }
  };

  return (
    <section className="trace-panel on" id="testPanel" aria-label="Consumer test">
      <div className="trace-head">
        <h2>🧪 Consumer test</h2>
        <label className="status" htmlFor="testUser">User</label>
        <select id="testUser" value={testUser} onChange={(e) => setTestUser(e.target.value)}>
          <option value="consumer1">consumer1</option><option value="consumer2">consumer2</option>
          {!["consumer1", "consumer2"].includes(testUser) && <option value={testUser}>{testUser}</option>}
        </select>
        <label className="status" htmlFor="testTurns">Turns</label>
        <input id="testTurns" type="number" min={1} max={60} value={turns} onChange={(e) => setTurns(Number(e.target.value))} style={{ width: 64 }} />
        <label className="status" htmlFor="testGap">Gap (s)</label>
        <input id="testGap" type="number" min={0} max={120} value={gap} onChange={(e) => setGap(Number(e.target.value))} style={{ width: 64 }} />
        <button type="button" className="primary" disabled={running} onClick={start}>▶ Start</button>
        <button type="button" disabled={!running} onClick={stop}>■ Stop</button>
        <button type="button" disabled={!thread} title="Open this consumer's chat" onClick={() => thread && onOpenChat(testUser, thread)}>Open chat</button>
        <span className="status"><span className={"live-dot" + (connected ? " on" : "")} /> {status}</span>
        <span className="grow" />
        <button type="button" onClick={onClose}>✕ Close</button>
      </div>
      <form className="send test-ask" onSubmit={send}>
        <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Ask Umbrella something yourself, as this consumer (works during a test too)" autoComplete="off" required />
        <button className="primary" type="submit">Send</button>
      </form>
      <div className="test-cols">
        <div className="trace-col" ref={feedBox}>
          {!feed.length && <div className="note">Start a test: another LLM plays Rohan, a working professional, and chats with Umbrella through a normal day as the chosen consumer (that consumer&apos;s own chat and memory). Each turn shows what Rohan said, the whole request sent to the LLM, what the LLM sent back, what the tools did, and Umbrella&apos;s reply.</div>}
          {feed.map((item) => item.kind === "note" ? <div key={item.key} className="note">{item.text}</div> : (
            <div key={item.turn} className="turn">
              <div className="turn-head"><b>{item.title}</b>{item.head}</div>
              {item.steps.map((s) => (
                <div key={s.key} className={"step new " + s.cls}>
                  <div className="ic">{s.icon}</div>
                  <div><div className="ttl">{s.title}</div>{s.sub && <div className="sub">{s.sub}</div>}{s.body}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="trace-col">
          <h3>Plan for the day</h3>
          <div className="note">One intent per message. Rohan writes the words himself and answers Umbrella&apos;s questions first.</div>
          {intents.map((intent, index) => (
            <div key={index} className={"intent" + (index < covered ? " done" : index === covered ? " now" : "")}>
              {`${index < covered ? "✅" : index === covered ? "▶" : "·"} ${index + 1}. ${intent}`}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
