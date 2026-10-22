"use client";
// The side tabs: Long-term, Short-term, Notes, Reminders, To-dos, Lists and Chat. Each shows what is
// saved (with ✏️ edit and 🗑 delete per row, and a clear-all button) and a "What to say" box.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, userPath } from "@/lib/api";
import { SAY } from "@/lib/say";
import { localInput, short, store } from "@/lib/util";

export const TABS: { id: string; label: string; title?: string }[] = [
  { id: "memory", label: "Long-term", title: "Lasting facts: profile, people, birthdays, preferences, projects" },
  { id: "short", label: "Short-term", title: "Things for the next 10 days" },
  { id: "notes", label: "Notes" },
  { id: "reminders", label: "Reminders" },
  { id: "todos", label: "To-dos" },
  { id: "lists", label: "Lists" },
  { id: "chat", label: "Chat", title: "What of the conversation goes to the LLM: recent messages and the running summary" },
];

type Field = { name: string; label: string; value: unknown; type?: "text" | "textarea" | "date" | "datetime-local" | "select" | "checkbox"; options?: string[] };

type Memory = { id: string; text: string; scope: string; category?: string; subject?: string; topic?: string; pinned?: boolean; date?: string; expires_at?: string; confidence?: number; key?: string };
type Reminder = { id: string; text: string; due_at: string; repeat: string; status: string; all_day: boolean };
type Note = { id: string; title?: string; text: string; created_at: string; keywords?: string[] };
type Todo = { id: string; text: string; day: string; done: boolean; priority: string };
type ListItem = { id: string; text: string; done: boolean };
type ChatState = {
  short_term: { conversation: { summary: string; summarized_count: number } | null; total: number; messages: { role: string; content: string; where: string }[] };
  rules: { window: number; summarize_after: number };
};

type Ctx = { user: string; thread: string; reload: () => void };

function ItemBox({ title, sub, actions, children }: { title: ReactNode; sub: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="item">
      <div className="k"><span>{sub}</span>{actions}</div>
      <div>{title}</div>
      {children}
    </div>
  );
}

function Editor({ fields, onSave, onCancel }: { fields: Field[]; onSave: (body: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map((f) => [f.name, f.type === "checkbox" ? Boolean(f.value) : f.value ?? ""])));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (name: string, value: unknown) => setValues((v) => ({ ...v, [name]: value }));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const body: Record<string, unknown> = {};
    for (const f of fields) {
      const value = values[f.name];
      if (f.type === "checkbox") body[f.name] = value;
      else if (String(value).trim() !== "") body[f.name] = String(value).trim();
    }
    setSaving(true);
    try { await onSave(body); } catch (err) { setError("Could not save: " + (err as Error).message.replace(/^\d+ /, "")); setSaving(false); }
  };
  return (
    <div className="item editing">
      <form className="edit-form" onSubmit={submit}>
        {fields.map((f, index) => {
          const value = values[f.name];
          if (f.type === "checkbox") {
            return <label key={f.name} className="check"><input type="checkbox" checked={Boolean(value)} onChange={(e) => set(f.name, e.target.checked)} />{f.label}</label>;
          }
          let input: ReactNode;
          if (f.type === "textarea") input = <textarea rows={3} autoFocus={index === 0} value={String(value)} onChange={(e) => set(f.name, e.target.value)} />;
          else if (f.type === "select") input = <select autoFocus={index === 0} value={String(value)} onChange={(e) => set(f.name, e.target.value)}>{f.options!.map((o) => <option key={o} value={o}>{o}</option>)}</select>;
          else input = <input type={f.type || "text"} autoFocus={index === 0} value={String(value)} onChange={(e) => set(f.name, e.target.value)} />;
          return <label key={f.name}>{f.label}{input}</label>;
        })}
        <div className="edit-error">{error}</div>
        <div className="buttons">
          <button className="primary" disabled={saving}>Save</button>
          <button type="button" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

// ✏️ Edit and 🗑 Delete on one row of a side panel.
function Editable({ ctx, kind, id, title, sub, fields, children }: { ctx: Ctx; kind: string; id: string; title: string; sub: string; fields: Field[]; children?: ReactNode }) {
  const [editing, setEditing] = useState(false);
  const url = `${userPath(ctx.user)}/items/${kind}/${id}?thread=${ctx.thread}`;
  if (editing) {
    return <Editor fields={fields} onCancel={() => setEditing(false)} onSave={async (body) => { await api(url, { method: "PATCH", body: JSON.stringify(body) }); setEditing(false); ctx.reload(); }} />;
  }
  const remove = async () => {
    if (!confirm(`Delete “${short(title, 60)}”?`)) return;
    try { await api(url, { method: "DELETE" }); } catch (error) { alert("Could not delete: " + (error as Error).message); }
    ctx.reload();
  };
  const actions = (
    <span className="acts">
      <button type="button" className="x edit" title="Edit" onClick={() => setEditing(true)}>✏️</button>
      <button type="button" className="x" title="Delete" onClick={remove}>🗑</button>
    </span>
  );
  return <ItemBox title={title} sub={sub} actions={actions}>{children}</ItemBox>;
}

// Manual override: empty a whole store after an "are you sure?" box (Umbrella asks the same in chat).
function ClearButton({ ctx, label, body }: { ctx: Ctx; label: string; body: Record<string, string> }) {
  const clear = async () => {
    if (!confirm(`${label}? This cannot be undone.`)) return;
    await api(`${userPath(ctx.user)}/clear`, { method: "POST", body: JSON.stringify({ ...body, thread: ctx.thread }) });
    ctx.reload();
  };
  return <button className="clear" onClick={clear}>{"🗑 " + label}</button>;
}

function SayBox({ name, onExample }: { name: string; onExample: (text: string) => void }) {
  const help = SAY[name];
  const [open, setOpen] = useState(() => store("companion.sayOpen." + name) !== "no");
  if (!help) return null;
  return (
    <details className="say" open={open} onToggle={(e) => { const now = (e.target as HTMLDetailsElement).open; setOpen(now); store("companion.sayOpen." + name, now ? "yes" : "no"); }}>
      <summary>💬 What to say</summary>
      <div className="body">
        <div className="kw">Words Umbrella listens for: {help.keywords.map((word, i) => <span key={word}>{i ? ", " : ""}<b>{word}</b></span>)}</div>
        <div className="kw">{help.tip}</div>
        {help.examples.map((example) => (
          <button key={example} type="button" className="ex" title="Put this in the message box" onClick={() => onExample(example)}>{"“" + example + "”"}</button>
        ))}
      </div>
    </details>
  );
}

function MemoryItems({ ctx, items, empty }: { ctx: Ctx; items: Memory[]; empty: string }) {
  if (!items.length) return <div className="empty">{empty}</div>;
  return items.map((m) => {
    const until = m.expires_at ? ` · until ${new Date(m.expires_at).toLocaleDateString()}` : "";
    const where = [m.category, m.subject, m.topic].filter(Boolean).join(" · ");
    const fields: Field[] = [{ name: "text", label: "Text", value: m.text, type: "textarea" }];
    if (m.scope === "long") fields.push({ name: "subject", label: "Who / what", value: m.subject }, { name: "topic", label: "Topic", value: m.topic });
    return <Editable key={m.id} ctx={ctx} kind="memory" id={m.id} title={m.text} sub={`${m.pinned ? "📌 " : ""}${where}${m.date ? " · " + m.date : ""}${until}`} fields={fields} />;
  });
}

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

// Loads what one tab shows, as plain data; the tab draws it below.
async function loadTab(tab: string, user: string, thread: string): Promise<unknown> {
  const base = userPath(user);
  if (tab === "memory" || tab === "short") return api(`${base}/memory?thread=${thread}`);
  if (tab === "reminders") return api(`${base}/reminders?thread=${thread}`);
  if (tab === "notes") return api(`${base}/notes?thread=${thread}`);
  if (tab === "todos" || tab === "lists") return api(`${base}/lists?thread=${thread}`);
  return api(`${base}/memory/state?thread=${thread}`);
}

function TabBody({ tab, data, ctx }: { tab: string; data: unknown; ctx: Ctx }) {
  if (tab === "memory") {
    const { long_term, pending } = data as { long_term: Memory[]; pending: Memory[] };
    return (
      <>
        <h3>{`Long-term memory (${long_term.length})`}</h3>
        <MemoryItems ctx={ctx} items={long_term} empty="Nothing yet. Try: “remember long term: my sister Riya's birthday is 3 May”." />
        {long_term.length > 0 && <ClearButton ctx={ctx} label="Clear long-term memory" body={{ store: "long" }} />}
        {pending.length > 0 && <h3>Unsure (Umbrella will ask once)</h3>}
        {pending.map((m) => <ItemBox key={m.id} title={m.text} sub={`${m.category} · confidence ${m.confidence}`} />)}
      </>
    );
  }
  if (tab === "short") {
    const { short_term } = data as { short_term: Memory[] };
    return (
      <>
        <h3>{`Short-term memory, 10 days (${short_term.length})`}</h3>
        <MemoryItems ctx={ctx} items={short_term} empty="Nothing. Try: “short term: I have an exam on Friday”." />
        {short_term.length > 0 && <ClearButton ctx={ctx} label="Clear short-term memory" body={{ store: "short" }} />}
      </>
    );
  }
  if (tab === "reminders") {
    const { reminders } = data as { reminders: Reminder[] };
    return (
      <>
        {!reminders.length && <div className="empty">No reminders. Try: “remind me tomorrow at 9 to take medicine”.</div>}
        {reminders.map((r) => {
          const flags = (r.repeat !== "none" ? " · " + r.repeat : "") + (r.status !== "pending" ? " · " + r.status : "");
          const when = r.all_day ? "📅 " + dayLabel(r.due_at) + " · all day" : new Date(r.due_at).toLocaleString();
          return (
            <Editable key={r.id} ctx={ctx} kind="reminder" id={r.id} title={r.text} sub={when + flags} fields={[
              { name: "text", label: "What", value: r.text },
              { name: "when", label: r.all_day ? "Day (said at 9:00 that morning)" : "When", value: localInput(r.due_at), type: "datetime-local" },
              { name: "repeat", label: "Repeat", value: r.repeat, type: "select", options: ["none", "daily", "weekly", "monthly"] },
              { name: "all_day", label: "Full day (no time)", value: r.all_day, type: "checkbox" },
            ]} />
          );
        })}
        {reminders.length > 0 && <ClearButton ctx={ctx} label="Clear all reminders" body={{ store: "reminders" }} />}
      </>
    );
  }
  if (tab === "notes") {
    const { notes } = data as { notes: Note[] };
    return (
      <>
        <h3>{`Notes (${notes.length})`}</h3>
        {!notes.length && <div className="empty">No notes. Try: “note down the wifi password: abc123”.</div>}
        {notes.map((n) => (
          <Editable key={n.id} ctx={ctx} kind="note" id={n.id} title={n.text} sub={`${n.title || "Note"} · ${new Date(n.created_at).toLocaleDateString()}`} fields={[
            { name: "title", label: "Title", value: n.title }, { name: "text", label: "Text", value: n.text, type: "textarea" }]}>
            {n.keywords && n.keywords.length > 0 && <div className="sub">{"search words: " + n.keywords.join(", ")}</div>}
          </Editable>
        ))}
        {notes.length > 0 && <ClearButton ctx={ctx} label="Delete all notes" body={{ store: "notes" }} />}
      </>
    );
  }
  if (tab === "todos") {
    const { todos } = data as { todos: Todo[] };
    const open = todos.filter((t) => !t.done).length;
    const byDay: Record<string, Todo[]> = {};
    for (const t of todos) (byDay[t.day] ||= []).push(t);
    return (
      <>
        <h3>{`To-dos (${open} open, ${todos.length - open} done)`}</h3>
        {!todos.length && <div className="empty">No to-dos. Try: “add to my to-do: call the bank”.</div>}
        {Object.entries(byDay).map(([day, items]) => (
          <div key={day}>
            <div className="sub">{dayLabel(day + "T00:00")}</div>
            {items.map((t) => (
              <Editable key={t.id} ctx={ctx} kind="todo" id={t.id} title={(t.done ? "✅ " : "⬜ ") + t.text} sub={t.priority !== "normal" ? t.priority + " priority" : ""} fields={[
                { name: "text", label: "Task", value: t.text }, { name: "day", label: "Day", value: t.day, type: "date" },
                { name: "priority", label: "Priority", value: t.priority, type: "select", options: ["low", "normal", "high"] },
                { name: "done", label: "Done", value: t.done, type: "checkbox" }]} />
            ))}
          </div>
        ))}
        {todos.length > 0 && <ClearButton ctx={ctx} label="Clear all to-dos" body={{ store: "todos" }} />}
      </>
    );
  }
  if (tab === "lists") {
    const { lists } = data as { lists: Record<string, ListItem[]> };
    const names = Object.keys(lists);
    return (
      <>
        {!names.length && <div className="empty">No lists. Try: “add milk and eggs to my shopping list”.</div>}
        {Object.entries(lists).map(([name, items]) => (
          <div key={name}>
            <h3>{`${name} (${items.filter((i) => !i.done).length} left)`}</h3>
            {items.map((i) => (
              <Editable key={i.id} ctx={ctx} kind="list_item" id={i.id} title={(i.done ? "✅ " : "⬜ ") + i.text} sub="" fields={[
                { name: "text", label: "Item", value: i.text }, { name: "done", label: "Ticked", value: i.done, type: "checkbox" }]} />
            ))}
            <ClearButton ctx={ctx} label={`Empty the ${name} list`} body={{ store: "list", list: name }} />
          </div>
        ))}
      </>
    );
  }
  // Chat: the conversation memory the LLM gets (recent messages word for word + a running summary).
  const { short_term: st, rules: r } = data as ChatState;
  return (
    <>
      <div className="note">{`The last ${r.window} messages go to the LLM word for word. Older ones are folded into the running summary (after ${r.summarize_after} unsummarized messages).`}</div>
      {!st.conversation ? <div className="empty">No conversation yet.</div> : (
        <>
          <div className="sub">{`${st.total} messages · ${st.conversation.summarized_count} folded into the summary`}</div>
          <h3>Running summary</h3>
          {st.conversation.summary ? <div className="item">{st.conversation.summary}</div> : <div className="empty">No summary yet (the chat is still short).</div>}
          <h3>Messages</h3>
          {st.messages.slice().reverse().map((m, i) => {
            const where = ({ window: "sent to LLM", summary: "in summary", stored: "stored only" } as Record<string, string>)[m.where] || m.where;
            return <ItemBox key={i} title={m.content} sub={`${m.role === "user" ? "you" : "Umbrella"} · ${where}`} />;
          })}
        </>
      )}
    </>
  );
}

export function SidePanel({ user, thread, refreshKey, onExample }: { user: string; thread: string; refreshKey: number; onExample: (text: string) => void }) {
  const [tab, setTab] = useState("memory");
  const [state, setState] = useState<{ tab: string; data?: unknown; error?: string } | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let current = true;
    loadTab(tab, user, thread)
      .then((data) => { if (current) setState({ tab, data }); })
      .catch((error: Error) => { if (current) setState({ tab, error: error.message }); });
    return () => { current = false; };
  }, [tab, user, thread, refreshKey, version]);

  const ctx: Ctx = { user, thread, reload };
  return (
    <aside>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} title={t.title} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      <div className="panel" id="panel">
        {state && state.tab === tab && (state.error ? `Could not load: ${state.error}` : (
          <>
            <SayBox key={tab} name={tab} onExample={onExample} />
            <TabBody tab={tab} data={state.data} ctx={ctx} />
          </>
        ))}
      </div>
    </aside>
  );
}

export type SidePanelTab = (typeof TABS)[number]["id"];
