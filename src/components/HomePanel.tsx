"use client";
// 🏠 Home: the home-automation simulator. Left: the devices (with buttons to change them by hand).
// Middle: fake people and gesture events (the same ones the camera sends) and the rules.
// Right: the home-activity log, live: every action record and what the narrator said.
// Everything goes through the companion server's /v1/home API; updates arrive on the home's trace stream.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, companionUrl, postJson, traceSource } from "@/lib/api";
import { store } from "@/lib/util";
import { encodeWav } from "@/lib/audio";

// Umbrella's voice for home lines (the server's /v1/tts): one line at a time, never on top of each other.
// While one plays, only the newest waiting line is kept (a burst of changes is not read out one by one).
const voice = {
  playing: null as HTMLAudioElement | null,
  waiting: "",
  busy: false,
  say(text: string) {
    this.waiting = text;
    if (!this.busy) void this.next();
  },
  async next() {
    const text = this.waiting;
    this.waiting = "";
    if (!text) { this.busy = false; return; }
    this.busy = true;
    try {
      const response = await fetch(companionUrl("/v1/tts"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, speed: 1 }),
      });
      if (response.ok && this.busy) {
        const audio = new Audio(URL.createObjectURL(await response.blob()));
        this.playing = audio;
        await new Promise<void>((done) => { audio.onended = audio.onerror = () => done(); audio.play().catch(() => done()); });
        URL.revokeObjectURL(audio.src);
        this.playing = null;
      }
    } catch { /* no voice: the line is still shown */ }
    if (this.busy) await this.next();
  },
  stop() {   // the panel closes or 🔊 is switched off: silence now, forget what was waiting
    this.waiting = "";
    this.busy = false;
    this.playing?.pause();
    this.playing = null;
  },
};

// 🎤 Talk to Umbrella about the home ("turn off the fan", "lamp 60 percent kar do"). Click to start, click
// again to stop (stops by itself after 15 s). The words go through speech to text (/v1/stt), then to
// Umbrella's chat as the dashboard's current user (/v1/chat), whose home tools change the devices.
// Umbrella's line about the change then shows above (and is spoken when 🔊 speak is on).
type Recorder = {
  stream: MediaStream; context: AudioContext; node: ScriptProcessorNode; chunks: Float32Array[];
  timer: ReturnType<typeof setTimeout>; preview: ReturnType<typeof setInterval>;
};
type Heard = { text: string; provider: string; ms: number };

const seconds = (ms: number) => (ms / 1000).toFixed(1) + " s";

// Speech to text for a clip (the server's /v1/stt: Groq first, then Whisper on this laptop, then Sarvam).
async function hear(chunks: Float32Array[], rate: number): Promise<Heard> {
  const started = performance.now();
  const response = await fetch(companionUrl("/v1/stt"), { method: "POST", headers: { "Content-Type": "audio/wav" }, body: encodeWav(chunks, rate) });
  if (!response.ok) throw new Error((await response.text()) || `speech to text failed (${response.status})`);
  const data = await response.json();
  return { text: (data.text || "").trim(), provider: data.provider || "", ms: Math.round(performance.now() - started) };
}

function VoiceButton({ onResult }: { onResult: (text: string) => void }) {
  const [phase, setPhase] = useState<"idle" | "listening" | "working">("idle");
  const recorder = useRef<Recorder | null>(null);
  const previewing = useRef(false);   // one live preview at a time (a slow STT must not pile up requests)

  const stop = useCallback(async () => {
    const r = recorder.current;
    if (!r) return;
    recorder.current = null;
    clearTimeout(r.timer); clearInterval(r.preview);
    r.node.disconnect(); r.stream.getTracks().forEach((t) => t.stop());
    const rate = r.context.sampleRate;
    await r.context.close();
    setPhase("working");
    try {
      onResult("🎤 Turning your voice into text…");
      const heard = await hear(r.chunks, rate);
      if (!heard.text) { onResult(`🎤 I didn't catch any words (${heard.provider}, ${seconds(heard.ms)}). Try again, a little closer to the mic.`); return; }
      const said = `🎤 “${heard.text}” (text by ${heard.provider} in ${seconds(heard.ms)})`;
      onResult(`${said} → Umbrella is thinking…`);
      const started = performance.now();
      const reply = await postJson<{ text?: string; provider?: string }>("/v1/chat", { user_id: store("companion.user") || "ashish", text: heard.text });
      const provider = (reply.provider || "").split(":")[0];
      onResult(`${said} → ${reply.text || "done"} (${provider} in ${seconds(performance.now() - started)})`);
    } catch (error) {
      onResult("🎤 " + (error as Error).message);
    } finally {
      setPhase("idle");
    }
  }, [onResult]);

  const start = async () => {
    voice.stop();   // Umbrella stops talking while you talk (the mic must not hear the speaker)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const node = context.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      node.onaudioprocess = (event) => { chunks.push(new Float32Array(event.inputBuffer.getChannelData(0))); };
      source.connect(node); node.connect(context.destination);
      // Your words so far, while you talk (speech to text only: nothing is sent to Umbrella yet).
      const preview = setInterval(async () => {
        if (previewing.current || chunks.length < 4) return;
        previewing.current = true;
        try {
          const heard = await hear(chunks.slice(), context.sampleRate);
          if (recorder.current && heard.text) onResult(`🎤 Hearing: “${heard.text}” … (${heard.provider}, ${seconds(heard.ms)})`);
        } catch { /* the final text still comes when you stop */ }
        previewing.current = false;
      }, 1200);
      recorder.current = { stream, context, node, chunks, preview, timer: setTimeout(() => { stop(); }, 15000) };
      onResult("🎤 Listening… speak now, your words appear here.");
      setPhase("listening");
    } catch (error) {
      onResult("🎤 Mic not available: " + (error as Error).message);
    }
  };

  useEffect(() => () => {   // the panel closes while recording: let the mic go
    const r = recorder.current;
    if (r) { clearTimeout(r.timer); clearInterval(r.preview); r.stream.getTracks().forEach((t) => t.stop()); r.context.close(); }
  }, []);

  return (
    <button type="button" className={"home-mic" + (phase === "listening" ? " on" : "")} disabled={phase === "working"}
      onClick={() => (phase === "listening" ? stop() : start())}
      title="Say a home command: “turn off the fan”, “TV on karo”, “lamp 60 percent”">
      {phase === "listening" ? "⏹ Stop" : phase === "working" ? "… working" : "🎤 Talk"}
    </button>
  );
}

type Device = {
  id: string; kind: "light" | "fan" | "ac" | "tv"; room: string; name: string; on: boolean;
  speed?: number; temperature?: number; dimmable?: boolean; brightness?: number;
};
type Rule = { name: string; when: string; hours: string; cooldown: number; repeat?: boolean };
type HomeState = { home_id: string; present: boolean; devices: Device[]; rules: Rule[] };
type VisionStatus = {
  available: boolean; running: boolean; error?: string; fps?: number; hands_ms?: number; objects_ms?: number;
  people?: number; gesture?: string; gesture_at?: number;
  present?: boolean; empty_for?: number | null; leave_seconds?: number; left_sent?: boolean; waiting_cooldown?: boolean;
};

// The empty-room countdown under the camera: how long nobody has been in view, and when everything goes off.
function emptyRoom(v: VisionStatus | null): { text: string; hot: boolean } {
  if (!v || v.empty_for == null) return { text: v?.present ? "someone here" : "–", hot: false };
  if (v.waiting_cooldown) return { text: "empty · off when the cooldown ends", hot: true };
  if (v.left_sent) return { text: `empty ${Math.round(v.empty_for)} s · switched off`, hot: false };
  const left = Math.max(0, Math.round((v.leave_seconds ?? 120) - v.empty_for));
  return { text: `empty ${Math.round(v.empty_for)} s · all off in ${left} s`, hot: true };
}

// Umbrella's camera (companion/vision): the live annotated picture and what it sees now. It only reports
// (people in view, a held gesture); the rules decide. The picture is an MJPEG stream shown by a plain <img>.
function CameraCard() {
  const [vision, setVision] = useState<VisionStatus | null>(null);
  const [polledAt, setPolledAt] = useState(0);   // seconds; when the status was read (for "recent gesture")
  const [busy, setBusy] = useState(false);
  const [stamp, setStamp] = useState(0);   // a new value reconnects the picture after the camera restarts
  const [error, setError] = useState("");

  useEffect(() => {
    let current = true;
    const poll = () => api<VisionStatus>("/v1/vision/status")
      .then((v) => { if (current) { setVision(v); setPolledAt(Date.now() / 1000); } }).catch(() => {});
    poll();
    const timer = setInterval(poll, 1500);
    return () => { current = false; clearInterval(timer); };
  }, []);

  const switchTo = async (on: boolean) => {
    setBusy(true); setError("");
    try {
      setVision(await postJson<VisionStatus>(on ? "/v1/vision/start" : "/v1/vision/stop"));
      setStamp(Date.now());
    } catch (err) { setError((err as Error).message); }
    setBusy(false);
  };

  if (vision && !vision.available) {
    return <div className="note">The camera is off on the server (home.toml [camera] enabled, and the vision dependencies installed).</div>;
  }
  const recent = vision?.gesture && vision.gesture_at && polledAt - vision.gesture_at < 5;
  return (
    <div className="cam-card">
      <div className="cam-view">
        {vision?.running
          // eslint-disable-next-line @next/next/no-img-element -- a live MJPEG stream; next/image cannot show one
          ? <img src={companionUrl(`/v1/vision/camera.mjpg?t=${stamp}`)} alt="Umbrella's camera" />
          : <div className="cam-off">{vision?.error ? `Camera error: ${vision.error}` : "Camera is off"}</div>}
      </div>
      <div className="ctl">
        <button type="button" className={vision?.running ? "" : "primary"} disabled={busy} onClick={() => switchTo(!vision?.running)}>
          {busy ? "…" : vision?.running ? "📷 Camera off" : "📷 Camera on"}
        </button>
        {vision?.running && <span className="sub">{`${vision.fps ?? 0} fps · hands ${vision.hands_ms ?? 0} ms · YOLO ${vision.objects_ms ?? 0} ms`}</span>}
      </div>
      {error && <div className="sub" style={{ color: "var(--bad)" }}>{error}</div>}
      <div className="cam-now">
        <div><span>People (YOLO)</span><b>{vision?.people ?? 0}</b></div>
        <div className={recent ? "hot" : ""}><span>Last gesture</span><b>{vision?.gesture || "–"}</b></div>
        <div className={emptyRoom(vision).hot ? "hot" : ""}><span>Room</span><b>{emptyRoom(vision).text}</b></div>
      </div>
    </div>
  );
}
type Action = {
  id: string; at: string; source: string; trigger: string; device_id: string; device_name?: string; action: string;
  value: number | null; before: Record<string, unknown>; after: Record<string, unknown>; status: string; error: string;
};
type Message = { id: string; at: string; text: string; method: string; provider?: string };

const ICONS: Record<Device["kind"], string> = { light: "💡", fan: "🌀", ac: "❄️", tv: "📺" };
const GESTURES = ["pointing_up", "closed_fist", "i_love_you", "victory", "thumb_up", "thumb_down"];   // MediaPipe names, as the camera sends them
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false });
const brief = (s: Record<string, unknown>) =>
  Object.entries(s).map(([k, v]) => (k === "on" ? (v ? "on" : "off") : `${k} ${v}`)).join(", ") || "–";

function DeviceCard({ d, send }: { d: Device; send: (device: string, action: string, value?: number) => void }) {
  return (
    <div className={"dev" + (d.on ? " on" : "")}>
      <div className="dev-head">
        <span className="dev-icon">{ICONS[d.kind]}</span>
        <b>{d.name}</b>
        <span className={"badge " + (d.on ? "ok" : "stored")}>{d.on ? "on" : "off"}</span>
      </div>
      <div className="sub">
        {d.room}
        {d.kind === "fan" && ` · speed ${d.speed}`}
        {d.kind === "ac" && ` · ${d.temperature} °C`}
        {d.dimmable && ` · ${d.brightness} %`}
      </div>
      {d.dimmable && <div className="dim-bar"><span style={{ width: `${d.brightness ?? 0}%` }} /></div>}
      <div className="ctl">
        <button type="button" onClick={() => send(d.id, "toggle")}>{d.on ? "Turn off" : "Turn on"}</button>
        {(d.kind === "fan" || d.kind === "ac" || d.dimmable) && (
          <>
            <button type="button" title={d.kind === "fan" ? "Slower" : d.kind === "ac" ? "Cooler" : "Dimmer"} onClick={() => send(d.id, "down")}>−</button>
            <button type="button" title={d.kind === "fan" ? "Faster" : d.kind === "ac" ? "Warmer" : "Brighter"} onClick={() => send(d.id, "up")}>+</button>
          </>
        )}
      </div>
    </div>
  );
}

export function HomePanel({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<HomeState | null>(null);
  const [actions, setActions] = useState<Action[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  // Umbrella's newest line about the home (the narrator), shown on top and, if switched on, said aloud.
  const [said, setSaid] = useState<{ text: string; method: string; key: number } | null>(null);
  const [speak, setSpeak] = useState(() => store("companion.homeSpeak") === "yes");
  const speakRef = useRef(speak);
  useEffect(() => { speakRef.current = speak; store("companion.homeSpeak", speak ? "yes" : "no"); if (!speak) voice.stop(); }, [speak]);
  const lastSpoken = useRef(0);   // the newest trace event id already handled (replays are not spoken again)
  const openedAt = useRef(0);
  useEffect(() => { openedAt.current = Date.now(); }, []);
  const [connected, setConnected] = useState(false);
  const [custom, setCustom] = useState("");
  const [held, setHeld] = useState(false);   // send gestures as "still held" (a repeat step), like the camera does
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const [home, log] = await Promise.all([
        api<HomeState>("/v1/home"),
        api<{ actions: Action[]; messages: Message[] }>("/v1/home/log?limit=60"),
      ]);
      setState(home); setActions(log.actions); setMessages(log.messages); setError("");
      const newest = log.messages[0];
      if (newest) setSaid((now) => now ?? { text: newest.text, method: newest.method, key: 0 });   // the last line, on opening
    } catch (err) { setError((err as Error).message); }
  }, []);

  // First load, then reload (at most every 250 ms) whenever the home's trace says something changed.
  useEffect(() => {
    let source: EventSource | null = null;
    let current = true;
    const refresh = () => { clearTimeout(timer.current); timer.current = setTimeout(() => { if (current) load(); }, 250); };
    api<HomeState>("/v1/home").then((home) => {
      if (!current) return;
      setState(home);
      load();
      source = traceSource(home.home_id);
      source.onopen = () => setConnected(true);
      source.onerror = () => setConnected(false);
      source.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as { id: number; at: number; kind: string; data: { text?: string; method?: string } };
          if (!String(event.kind).startsWith("home_")) return;
          refresh();
          if (event.kind === "home_message" && event.data.text) {
            setSaid({ text: event.data.text, method: event.data.method || "", key: Date.now() });
            // The stream first replays recent events (also after every reconnect): speak only lines that
            // are new since the panel opened, each once.
            if (speakRef.current && event.id > lastSpoken.current && event.at * 1000 >= openedAt.current - 1000) voice.say(event.data.text);
            lastSpoken.current = Math.max(lastSpoken.current, event.id);
          }
        } catch { /* skip */ }
      };
    }).catch((err: Error) => setError(err.message));
    return () => { current = false; clearTimeout(timer.current); source?.close(); voice.stop(); };
  }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Every button goes through here: the result line shows what happened right away (the log follows live).
  const run = async (label: string, path: string, body: unknown) => {
    try {
      const done = await postJson<{ records?: Action[]; events?: { kind: string }[]; say?: string; ask?: string; message?: Message | null }>(path, body);
      const changed = (done.records || []).filter((r) => r.status !== "unchanged");
      const parts = [
        done.events && done.events.length ? "events: " + done.events.map((e) => e.kind).join(", ") : "",
        changed.length ? changed.map((r) => `${r.device_name || r.device_id} ${r.status}`).join(", ") : "",
        done.say || done.ask || (done.message ? "💬 " + done.message.text : ""),
      ].filter(Boolean);
      setNote(`${label}: ${parts.join(" · ") || "nothing happened (no rule fits, a cooldown, or already like that)"}`);
      load();
    } catch (err) { setNote(`${label}: ${(err as Error).message}`); }
  };
  const send = (device: string, action: string, value?: number) => run(`${device} ${action}`, "/v1/home/command", { device, action, value });
  const event = (label: string, body: Record<string, unknown>) => run(label, "/v1/home/events", { source: "sim", ...body });
  const signals = (label: string, body: Record<string, unknown>) => run(label, "/v1/home/signals", { source: "sim", ...body });

  const rooms: Record<string, Device[]> = {};
  for (const d of state?.devices || []) (rooms[d.room] ||= []).push(d);
  const names: Record<string, string> = Object.fromEntries((state?.devices || []).map((d) => [d.id, d.name]));

  return (
    <section className="trace-panel on" aria-label="Home">
      <div className="trace-head">
        <h2>🏠 Home</h2>
        <span className="status">
          <span className={"live-dot" + (connected ? " on" : "")} /> {connected ? "live" : "connecting…"}
          {state && ` · ${state.present ? "someone is home" : "nobody in view"}`}
        </span>
        <span className="grow" />
        <button type="button" onClick={onClose}>✕ Close</button>
      </div>
      {error && <div className="note" style={{ margin: 12 }}>{`Could not load the home: ${error}. Is the companion server running with COMPANION_HOME on?`}</div>}
      <div className="home-said">
        <span className="face-big">💬</span>
        {said ? (
          <div key={said.key} className="said-line">
            <b>{said.text}</b>
            <span className="sub">{said.method === "reply" ? "reply to a command (line bank, no AI)" : said.method === "llm" ? "AI line (old)" : "from the line bank, no AI"}</span>
          </div>
        ) : (
          <div className="said-line"><span className="sub">Umbrella&apos;s line appears here after each change (fan speed, a light on or off…).</span></div>
        )}
        <VoiceButton onResult={setNote} />
        <label className="sub speak-toggle" title="Say each new line aloud (Umbrella's voice)">
          <input type="checkbox" checked={speak} onChange={(e) => setSpeak(e.target.checked)} /> 🔊 speak
        </label>
      </div>
      {note && <div className="home-note">{note}</div>}
      <div className="trace-cols">
        <div className="trace-col">
          <h3>Camera (YOLO + hand gestures)</h3>
          <CameraCard />
          <h3>Devices (simulated)</h3>
          <div className="note">The buttons are direct commands (recorded as “manual”), like a voice command: no rules.</div>
          {Object.entries(rooms).map(([room, devices]) => (
            <div key={room}>
              <div className="sub">{room}</div>
              <div className="dev-grid">{devices.map((d) => <DeviceCard key={d.id} d={d} send={send} />)}</div>
            </div>
          ))}
          <div className="ctl" style={{ marginTop: 8 }}>
            <button type="button" onClick={() => send("all lights", "off")}>All lights off</button>
            <button type="button" onClick={() => send("everything", "off")}>Everything off</button>
          </div>
        </div>

        <div className="trace-col">
          <h3>Simulate (the same events the camera sends)</h3>
          <div className="note">These go through the rules in home.toml: no AI in the loop. After a change, Umbrella says one short line picked from home_lines.toml (no AI).</div>
          <div className="sub">People (YOLO)</div>
          <div className="ctl">
            <button type="button" onClick={() => signals("person in view", { people: 1 })}>🚶 Person enters</button>
            <button type="button" onClick={() => signals("room empty", { people: 0 })} title="Counts as left after leave_minutes">🫥 Room empty</button>
            <button type="button" onClick={() => event("person left", { kind: "person_left" })} title="Skip the wait">🚪 Left now</button>
          </div>
          <div className="sub">Gestures (MediaPipe)</div>
          <div className="ctl">
            {GESTURES.map((g) => <button key={g} type="button" onClick={() => event(`gesture ${g}${held ? " (held)" : ""}`, { kind: "gesture", name: g, source: "gesture", repeat: held })}>{g}</button>)}
            <label className="sub" title="As if the hand stays up: only rules with repeat = true act on it">
              <input type="checkbox" checked={held} onChange={(e) => setHeld(e.target.checked)} /> held
            </label>
          </div>
          <form className="ctl" onSubmit={(e) => { e.preventDefault(); if (custom.trim()) event(`gesture ${custom}`, { kind: "gesture", name: custom.trim(), source: "gesture" }); }}>
            <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="another gesture name" />
            <button type="submit">Send</button>
          </form>

          <h3>Rules (home.toml)</h3>
          {state?.rules.map((r) => (
            <div key={r.name} className="sub">
              <b>{r.name}</b>{` · when ${r.when}${r.hours ? ` · ${r.hours} h` : ""}${r.cooldown ? ` · cooldown ${r.cooldown} min` : ""}${r.repeat ? " · repeats while held" : ""}`}
            </div>
          ))}
        </div>

        <div className="trace-col">
          <h3>Narrator</h3>
          {!messages.length && <div className="empty">Nothing said yet.</div>}
          {messages.map((m) => (
            <div key={m.id} className="mem">
              <div className="k"><span>{time(m.at)}</span><span className={"badge " + (m.method === "llm" ? "prompt" : "ok")}>{m.method}</span>{m.provider && <span>{m.provider}</span>}</div>
              <div>{"💬 " + m.text}</div>
            </div>
          ))}
          <h3>Action log</h3>
          {!actions.length && <div className="empty">No actions yet.</div>}
          {actions.map((a) => (
            <div key={a.id} className={"msg " + (a.status === "done" ? "window" : a.status === "asking" ? "summary" : "stored")}>
              <span className="t">{time(a.at)}</span>{" "}
              <span className={"badge " + (a.status === "done" ? "ok" : a.status === "failed" ? "failed" : a.status === "asking" ? "ask" : "stored")}>{a.status}</span>{" "}
              <b>{a.device_name || names[a.device_id] || a.device_id}</b>{` ${a.action}${a.value != null ? " " + a.value : ""}`}
              <div className="sub">{`${brief(a.before)} → ${brief(a.after)} · ${a.trigger} · ${a.source}`}{a.error ? ` · ${a.error}` : ""}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
