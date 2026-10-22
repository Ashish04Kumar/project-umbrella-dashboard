"use client";
// 🎛️ Turn taking, live: every decision of a live call (trace events "live_turn"), newest first.
import { useEffect, useState } from "react";
import { traceSource, type TraceEvent } from "@/lib/api";
import { short } from "@/lib/util";

const LIVE_ICONS: Record<string, string> = {
  "smart turn": "🎧", waiting: "⏳", sent: "➤", merge: "🔗", "barge-in": "✋", "barge-in ignored": "🙉",
  "backchannel ignored": "👂", "stopped on request": "✋", "reply dropped": "🗑",
};

type Entry = { key: string; at: number; decision: string; reason: string; text?: string };

// `since` is when the call started (the log shows that call's decisions); `listening` is false after the
// call ends: the log stays on screen until the next call, but stops listening. The parent gives each
// call its own key, so a new call starts with an empty, open log.
export function LiveLog({ user, since, listening }: { user: string; since: number; listening: boolean }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!listening) return;
    const source = traceSource(user);
    source.onmessage = (message) => {
      let event: TraceEvent;
      try { event = JSON.parse(message.data); } catch { return; }
      if (event.kind !== "live_turn" || event.at < since) return;
      const d = event.data as { decision: string; reason: string; text?: string };
      setEntries((list) => [{ key: `${event.at}-${list.length}`, at: event.at, ...d }, ...list].slice(0, 60));
    };
    return () => source.close();
  }, [user, since, listening]);

  return (
    <details className="livelog on" id="livelog" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>🎛️ Turn taking, live <span className="status">(why Umbrella waited, answered or stopped)</span></summary>
      <div id="livelogList">
        {entries.map((e) => (
          <div key={e.key} className="lt">
            <span className="t">{new Date(e.at * 1000).toLocaleTimeString([], { hour12: false })}</span>
            <span>{LIVE_ICONS[e.decision] || "•"}</span>
            <div><b>{e.decision}</b> <span className="why">{e.reason + (e.text ? ` · “${short(e.text, 80)}”` : "")}</span></div>
          </div>
        ))}
      </div>
    </details>
  );
}
