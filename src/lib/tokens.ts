// Token counter: Start counts the LLM tokens of every reply from then on, Stop freezes the total,
// Reset clears it. A tiny store that components read with useSyncExternalStore.
import type { Usage } from "./api";

export type TokenTotals = { running: boolean; since: number; elapsed: number; replies: number; calls: number; input: number; output: number };

let totals: TokenTotals = { running: false, since: 0, elapsed: 0, replies: 0, calls: 0, input: 0, output: 0 };
const listeners = new Set<() => void>();
const changed = (next: TokenTotals) => { totals = next; listeners.forEach((fn) => fn()); };

export const tokenStore = {
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  get: () => totals,
  count(usage: Usage | undefined) {
    if (!totals.running || !usage) return;
    changed({
      ...totals, replies: totals.replies + 1, calls: totals.calls + (usage.calls || []).length,
      input: totals.input + (usage.input || 0), output: totals.output + (usage.output || 0),
    });
  },
  toggle() {
    changed(totals.running
      ? { ...totals, running: false, elapsed: totals.elapsed + Date.now() - totals.since }
      : { ...totals, running: true, since: Date.now() });
  },
  reset() { changed({ ...totals, elapsed: 0, since: Date.now(), replies: 0, calls: 0, input: 0, output: 0 }); },
};

export const tokenSeconds = (t: TokenTotals) => Math.floor((t.elapsed + (t.running ? Date.now() - t.since : 0)) / 1000);
