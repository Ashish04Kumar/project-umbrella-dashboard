// Small helpers shared by the components.

export function store(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* private window or blocked storage: nothing is remembered */ }
  return null;
}

export const short = (text: unknown, n = 160) => {
  const value = String(text ?? "");
  return value.length > n ? value.slice(0, n) + "…" : value;
};

export const fmt = (n: unknown) => Number(n || 0).toLocaleString("en-IN");

// A reminder's time as the value of a datetime-local input (the browser's clock is the user's).
export function localInput(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const pretty = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

let counter = 0;
export const newId = () => `m${Date.now().toString(36)}${(counter++).toString(36)}`;
