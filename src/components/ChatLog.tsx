"use client";
// The chat: your bubbles on the right, Umbrella's on the left, each with its details underneath
// (mood, time, model, tokens, tools, sources), a 🔊 button, and { } buttons for the raw objects.
import { useEffect, useRef, useState } from "react";
import type { HeardTurn, Reply, Usage } from "@/lib/api";
import { face } from "@/lib/body";
import { fmt } from "@/lib/util";

export type DueReminder = { id: string; text: string; due: string; again?: boolean; thread?: string; speak: string };

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  expression?: string;
  thinking?: boolean;          // a streaming reply with no words yet
  reply?: Reply;               // the finished reply: drives the details line
  extra?: string[];            // more details after the reply's (voice provider, total time)
  heard?: HeardTurn;           // a push-to-talk turn: what the STT heard and how it sounded
  objects?: { label: string; object: unknown }[];
  usage?: Usage;               // a live reply's tokens (arrive after the reply)
  reminder?: DueReminder;      // a due reminder card with Done / snooze
  plain?: boolean;             // no 🔊 button
  places?: boolean;            // show "Where should I save" buttons without a details line (live replies)
};

type Props = {
  messages: ChatMessage[];
  onSpeak: (text: string) => void;
  onPlace: (place: string) => void;
  onReminder: (reminder: DueReminder, path: string) => Promise<void>;
};

export function TokenTag({ usage }: { usage: Usage }) {
  const calls = usage.calls || [];
  const think = usage.reasoning ? ` (think ${fmt(usage.reasoning)})` : "";
  const title = calls.length
    ? calls.map((c, i) => `${i + 1}. ${c.provider}: in ${fmt(c.input)}, out ${fmt(c.output)}${c.reasoning ? ` (think ${fmt(c.reasoning)})` : ""}${c.reported ? "" : " (provider sent no counts)"}`).join("\n")
    : "No LLM call this turn";
  return (
    <span className="tok" title={title}>
      {`🪙 in ${fmt(usage.input)} · out ${fmt(usage.output)}${think} · ${calls.length} call${calls.length === 1 ? "" : "s"}`}
    </span>
  );
}

// A small { } button under a chat bubble: shows the raw object of that message.
// Your message: what went to the backend. Umbrella's reply: the whole object that came back.
function ObjectButton({ label, object }: { label: string; object: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="objbtn" onClick={() => setOpen(!open)}>{`{ } ${label}`}</button>
      {open && <div className="objview">{JSON.stringify(object, null, 2)}</div>}
    </>
  );
}

// Umbrella asked "Where should I save “…”? (reminder / to-do / …)": one button per place.
function PlaceButtons({ text, onPlace }: { text: string; onPlace: (place: string) => void }) {
  const [used, setUsed] = useState(false);
  const match = /Where should I save .*\?\s*\(([^)]+)\)\s*$/.exec(text || "");
  if (!match) return null;
  return (
    <div className="choices">
      {match[1].split("/").map((p) => p.trim()).filter(Boolean).map((place) => (
        <button key={place} type="button" className="choice" disabled={used} onClick={() => { setUsed(true); onPlace(place); }}>{place}</button>
      ))}
    </div>
  );
}

// A due reminder is said out loud and gets two answers. Nobody answers: the server brings it back once more after 10 minutes.
function ReminderCard({ reminder, onAnswer }: { reminder: DueReminder; onAnswer: Props["onReminder"] }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const answer = async (path: string, text: string) => {
    setBusy(true);
    try { await onAnswer(reminder, path); setSaid(text); } catch (error) { setSaid("Could not save: " + (error as Error).message); }
  };
  return (
    <div className="reminder-card">
      <div>{`⏰ ${reminder.again ? "Reminder again" : "Reminder"}: ${reminder.text}`}</div>
      <div className="sub">{reminder.due}</div>
      <div className="buttons">
        <button type="button" disabled={busy} onClick={() => answer("done", "Marked done.")}>✅ Ho gaya</button>
        <button type="button" disabled={busy} onClick={() => answer("snooze?minutes=10", "Okay, again in 10 minutes.")}>⏰ 10 min baad</button>
      </div>
      {said && <div className="sub">{said}</div>}
    </div>
  );
}

function hostname(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function ReplyMeta({ message, onSpeak }: { message: ChatMessage; onSpeak: (text: string) => void }) {
  const reply = message.reply!;
  return (
    <div className="meta">
      <span className="tag">{reply.expression}</span>
      {reply.ms !== undefined && <span>{(reply.ms / 1000).toFixed(1) + " s"}</span>}
      {reply.provider && <span>{reply.provider}</span>}
      {reply.usage && reply.usage.calls && <TokenTag usage={reply.usage} />}
      {(reply.tools_used || []).map((tool, i) => <span key={i} className="tag">{"🔧 " + tool}</span>)}
      {(reply.sources || []).slice(0, 3).map((url) => <a key={url} href={url} target="_blank" rel="noopener">{hostname(url)}</a>)}
      {(message.extra || []).map((text, i) => <span key={"x" + i} className={i === 0 ? "tag" : ""}>{text}</span>)}
      <button type="button" className="speak" title="Say it aloud" onClick={() => onSpeak(message.text)}>🔊</button>
    </div>
  );
}

// What was heard (and, with ✨, how it sounded): the details under the user's voice bubble.
function HeardMeta({ turn }: { turn: HeardTurn }) {
  const c = turn.voice_cues;
  return (
    <div className="meta">
      <span className="tag">{"🎤 " + turn.stt_provider}</span>
      <span>{(turn.stt_ms / 1000).toFixed(1) + " s"}</span>
      {turn.language && <span>{turn.language}</span>}
      {c && (
        <>
          <span className="tag">✨ cues</span>
          <span>{`${c.speech_s ?? "?"}s speech` + (c.wpm ? ` · ${Math.round(c.wpm)} wpm` : "")
            + (c.pause_before_s != null ? ` · paused ${c.pause_before_s}s` : "") + (c.interrupted ? " · cut in" : "")}</span>
          <span>{"→ LLM: " + (turn.voice_note || "(nothing unusual)")}</span>
        </>
      )}
    </div>
  );
}

function Row({ message, onSpeak, onPlace, onReminder }: { message: ChatMessage } & Omit<Props, "messages">) {
  const mine = message.role === "user";
  return (
    <div className={"row " + (mine ? "me" : "bot") + (message.thinking ? " thinking" : "")}>
      {!mine && <div className="face">{face(message.expression)}</div>}
      <div>
        <div className="bubble">
          {message.reminder ? <ReminderCard reminder={message.reminder} onAnswer={onReminder} /> : message.thinking ? "…" : message.text}
        </div>
        {message.heard && <HeardMeta turn={message.heard} />}
        {message.reply && <ReplyMeta message={message} onSpeak={onSpeak} />}
        {!mine && !message.reply && !message.plain && !message.thinking && message.text && (
          <button type="button" className="speak" title="Say it aloud" onClick={() => onSpeak(message.text)}>🔊</button>
        )}
        {message.usage && message.usage.calls && <div className="meta"><TokenTag usage={message.usage} /></div>}
        {!mine && (message.reply || message.places) && <PlaceButtons text={message.text} onPlace={onPlace} />}
        {(message.objects || []).map((o, i) => <ObjectButton key={i} label={o.label} object={o.object} />)}
      </div>
    </div>
  );
}

export function ChatLog({ messages, onSpeak, onPlace, onReminder }: Props) {
  const log = useRef<HTMLDivElement>(null);
  // Follow the newest message, the way the playground scrolls on every new bubble and streamed piece.
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [messages]);
  return (
    <div className="log" id="log" aria-live="polite" ref={log}>
      {messages.map((m) => <Row key={m.id} message={m} onSpeak={onSpeak} onPlace={onPlace} onReminder={onReminder} />)}
    </div>
  );
}
