"use client";
// 🪙 Tokens bar above the message box: replies, LLM calls and input/output tokens added up while it runs.
import { useEffect, useReducer, useSyncExternalStore } from "react";
import { tokenSeconds, tokenStore } from "@/lib/tokens";
import { fmt } from "@/lib/util";

export function TokenBar() {
  const t = useSyncExternalStore(tokenStore.subscribe, tokenStore.get, tokenStore.get);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {   // the timer moves once a second while counting
    if (!t.running) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [t.running]);
  const s = tokenSeconds(t);
  const started = t.replies || s;
  return (
    <div className="tokbar" id="tokbar" title="Start counts the LLM tokens of every reply from now on; Stop freezes the total; Reset clears it.">
      <span>🪙 Tokens</span>
      <button type="button" className={t.running ? "on" : ""} onClick={tokenStore.toggle}>{t.running ? "⏸ Stop" : "▶ Start"}</button>
      <button type="button" onClick={tokenStore.reset}>↺ Reset</button>
      <span className="tokstate">{t.running ? "● counting" : started ? "stopped: total" : "off"}</span>
      <span><b>{`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`}</b></span>
      <span><b>{fmt(t.replies)}</b> replies</span>
      <span><b>{fmt(t.calls)}</b> LLM calls</span>
      <span>in <b>{fmt(t.input)}</b></span>
      <span>out <b>{fmt(t.output)}</b></span>
      <span>total <b>{fmt(t.input + t.output)}</b></span>
    </div>
  );
}
