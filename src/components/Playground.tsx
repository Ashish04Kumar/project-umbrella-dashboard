"use client";
// The whole dashboard: header (user, Live, Trace, Test, voice speed), the robot stage, the chat with its
// token bar and message box, the side tabs, and the Trace / Test panels. Everything talks to the
// companion server over HTTP: JSON calls, streamed replies (server-sent events over POST), LiveKit for Live.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Room } from "livekit-client";
import { api, companionUrl, postJson, streamPost, userPath, type Health, type Reply, type StreamEvent } from "@/lib/api";
import { b64ToWav, encodeWav, levelFromRms, rmsOf, VoicePlayer } from "@/lib/audio";
import { createBodyBus } from "@/lib/body";
import { tokenStore } from "@/lib/tokens";
import { newId, store } from "@/lib/util";
import { ChatLog, type ChatMessage, type DueReminder } from "./ChatLog";
import { LiveLog } from "./LiveLog";
import { SidePanel } from "./SidePanel";
import { Stage } from "./Stage";
import { TestPanel } from "./TestPanel";
import { TokenBar } from "./TokenBar";
import { TracePanel } from "./TracePanel";

const TEXT_PLACEHOLDER = "Umbrella se baat karo… (e.g. kal 9 baje dawai yaad dilana)";
const GREETING = "Hi! Main Umbrella hoon. Kuch bhi poocho, ya kaam bolo (reminder, list, note, yaad rakhna).";
const MIC_BUTTONS: Record<string, string> = { push_to_talk: "🎤", push_to_talk_cues: "🎙️✨" };
const STATES: Record<string, string> = { listening: "👂 listening", thinking: "💭 thinking", speaking: "🗣️ speaking", idle: "🙂 your turn" };
const FACES: Record<string, string> = { happy: "😊", curious: "🤔", concerned: "🫂", playful: "😜", idle: "🙂" };

type UserRow = { id: string; threads: number };
type ThreadRow = { thread: string; number: number; messages: number; first_message?: string };
type Recorder = {
  stream: MediaStream; context: AudioContext; source: MediaStreamAudioSourceNode; node: ScriptProcessorNode;
  chunks: Float32Array[]; rate: number; timer: ReturnType<typeof setTimeout>; preview: ReturnType<typeof setInterval>;
  mode: string; interrupted: boolean; gapMs: number | null;
};
type PendingVoice = { wav: Blob; mode: string; interrupted: boolean; gapMs: number | null };
type LiveMessage = {
  type: string; role?: string; text?: string; expression?: string; state?: string;
  request?: { text?: string }; response?: { usage?: Reply["usage"] }; resources?: { name: string; phone: string }[];
};

function healthText(h: Health) {
  return `${h.name} · ${h.tools.length} tools` + (h.tools.includes("web_search") ? " · web search on" : " · web search off")
    + ` · STT ${h.stt.join("→") || "none"} · TTS ${h.tts.join("→") || "none"}` + (h.live ? " · live ready" : " · live off");
}

export default function Playground() {
  const bus = useMemo(() => createBodyBus(), []);
  const [health, setHealth] = useState<Health | null>(null);
  const [status, setStatus] = useState("connecting…");
  const [users, setUsers] = useState<UserRow[]>([]);
  const [user, setUser] = useState("ashish");
  const [thread, setThread] = useState("main");
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [hearing, setHearing] = useState(false);
  const [placeholder, setPlaceholder] = useState(TEXT_PLACEHOLDER);
  const [sending, setSending] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const [recording, setRecording] = useState<string | null>(null);
  const [speed, setSpeed] = useState(1);
  const [refreshKey, setRefreshKey] = useState(0);
  const [traceOpen, setTraceOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [toasts, setToasts] = useState<{ id: string; text: string }[]>([]);
  const [live, setLive] = useState(false);
  const [liveStarting, setLiveStarting] = useState(false);
  const [liveBar, setLiveBar] = useState(false);
  const [liveFace, setLiveFace] = useState("idle");
  const [liveState, setLiveState] = useState("connecting…");
  const [liveSince, setLiveSince] = useState<number | null>(null);

  // Values the async code (streams, timers, the mic) reads at the moment it runs.
  const userRef = useRef(user);
  const threadRef = useRef(thread);
  const inputRef = useRef(input);
  const speedRef = useRef(speed);
  useEffect(() => { userRef.current = user; threadRef.current = thread; inputRef.current = input; speedRef.current = speed; }, [user, thread, input, speed]);
  const textBox = useRef<HTMLInputElement>(null);
  const recorder = useRef<Recorder | null>(null);
  const pendingVoice = useRef<PendingVoice | null>(null);
  const previewSeq = useRef(0);
  const liveRoom = useRef<{ room: Room; name: string } | null>(null);
  const liveAnalyser = useRef<(AnalyserNode & { ctx?: AudioContext }) | null>(null);
  const liveReply = useRef<string | null>(null);
  const lastLiveUser = useRef<string | null>(null);
  const lastLiveBot = useRef<string | null>(null);
  const liveExpression = useRef("idle");
  const demoMode = useRef(false);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const player = useMemo(() => new VoicePlayer((state) => bus.emit("state", state)), [bus]);
  useEffect(() => player.setRecordingCheck(() => recorder.current !== null), [player]);

  // --- chat rows -----------------------------------------------------------------------------------
  const add = useCallback((message: Omit<ChatMessage, "id">) => {
    const id = newId();
    setMessages((list) => [...list, { ...message, id }]);
    return id;
  }, []);
  const update = useCallback((id: string | null, fn: (m: ChatMessage) => ChatMessage) => {
    if (id) setMessages((list) => list.map((m) => (m.id === id ? fn(m) : m)));
  }, []);
  const remove = useCallback((id: string) => setMessages((list) => list.filter((m) => m.id !== id)), []);
  const attach = useCallback((id: string | null, label: string, object: unknown) => {
    if (object) update(id, (m) => ({ ...m, objects: [...(m.objects || []), { label, object }] }));
  }, [update]);

  // Memory is saved in the background after a reply, so the side tabs look again a little later.
  const refreshPanels = useCallback(() => {
    setRefreshKey((n) => n + 1);
    setTimeout(() => setRefreshKey((n) => n + 1), 4000);
    setTimeout(() => setRefreshKey((n) => n + 1), 12000);
  }, []);

  const bodyError = useCallback(() => {
    bus.emit("state", "error");
    clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => bus.emit("state", "idle"), 3000);
  }, [bus]);

  const toast = useCallback((text: string) => {
    const id = newId();
    setToasts((list) => [...list, { id, text }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 9000);
  }, []);

  const sayAloud = useCallback((text: string) => player.say(text, speedRef.current).catch(() => {}), [player]);

  // --- users, threads, history -------------------------------------------------------------------
  const loadHistory = useCallback(async (forUser: string, forThread: string) => {
    try {
      const { messages: rows } = await api<{ messages: { role: "user" | "assistant"; content: string; expression?: string }[] }>(
        `${userPath(forUser)}/history?limit=40&thread=${forThread}`);
      setMessages(rows.length ? rows.map((m) => ({ id: newId(), role: m.role, text: m.content, expression: m.expression }))
        : [{ id: newId(), role: "assistant", text: GREETING }]);
    } catch (error) {
      setMessages([{ id: newId(), role: "assistant", text: "Could not load history: " + (error as Error).message }]);
    }
  }, []);

  // Threads: main is thread 1. Each thread has its own chat AND its own memory, notes, reminders, to-dos and lists.
  const loadThreads = useCallback(async (forUser: string, forThread: string) => {
    try {
      const { threads: rows } = await api<{ threads: ThreadRow[] }>(`${userPath(forUser)}/threads`);
      if (!rows.some((t) => t.thread === forThread)) rows.push({ thread: forThread, number: rows.length + 1, messages: 0 });
      setThreads(rows);
    } catch { /* the server may be restarting */ }
  }, []);

  // Users: every user in the database, plus "New user…". A remembered user that is gone (the database was
  // wiped) falls back to "ashish" or the first user instead of bringing the old name back.
  const loadUsers = useCallback(async (selected?: string) => {
    let want = selected || store("companion.user") || "ashish";
    let rows: UserRow[] = [];
    try { ({ users: rows } = await api<{ users: UserRow[] }>("/v1/users")); } catch { /* server restarting */ }
    if (!selected && rows.length && !rows.some((u) => u.id === want)) {
      want = (rows.find((u) => u.id === "ashish") || rows[0]).id;
      store("companion.user", want);
    }
    if (!rows.some((u) => u.id === want)) rows.unshift({ id: want, threads: 0 });   // a new user, before its first message
    setUsers(rows);
    setUser(want);
    return want;
  }, []);

  const openThread = useCallback((forUser: string, forThread: string) => {
    setThread(forThread);
    loadThreads(forUser, forThread);
    loadHistory(forUser, forThread);
  }, [loadHistory, loadThreads]);

  const selectUser = useCallback(async (id: string) => {
    store("companion.user", id);
    const chosen = await loadUsers(id);
    openThread(chosen, "main");   // a user starts on their own main thread
  }, [loadUsers, openThread]);

  // --- due reminders -------------------------------------------------------------------------------
  // A due reminder is said out loud (the robot speaks it) and gets two answers.
  const checkDue = useCallback(async () => {
    try {
      const { due } = await api<{ due: DueReminder[] }>(`${userPath(userRef.current)}/reminders/due`);
      for (const r of due) {
        toast(`${r.text} (${r.due})`);
        add({ role: "assistant", text: "", expression: "happy", reminder: r });
        bus.emit("expression", "happy");
        sayAloud(r.speak);
      }
      if (due.length) setRefreshKey((n) => n + 1);
    } catch { /* the server may be restarting */ }
  }, [add, bus, sayAloud, toast]);

  const answerReminder = useCallback(async (r: DueReminder, path: string) => {
    const sep = path.includes("?") ? "&" : "?";
    await api(`${userPath(userRef.current)}/reminders/${r.id}/${path}${sep}thread=${r.thread || "main"}`, { method: "POST" });
    setRefreshKey((n) => n + 1);
  }, []);

  // --- start-up ------------------------------------------------------------------------------------
  useEffect(() => {
    api<Health>("/health")
      .then((h) => { setHealth(h); setStatus(healthText(h)); })
      .catch(() => setStatus("server not reachable"));
    // The user list first: the remembered user may be gone, and the rest loads for whoever is chosen.
    const start = async () => openThread(await loadUsers(), "main");
    start();
    const due = setInterval(checkDue, 20000);
    return () => clearInterval(due);
  }, [loadUsers, openThread, checkDue]);

  // The robot's mouth: Umbrella's voice level while it speaks, its live voice in a call, else silence.
  useEffect(() => {
    let frame = 0;
    const loop = () => {
      const voice = player.level();
      if (voice !== null) bus.emit("level", voice);
      else if (liveAnalyser.current) {
        const data = new Float32Array(liveAnalyser.current.fftSize);
        liveAnalyser.current.getFloatTimeDomainData(data);
        bus.emit("level", levelFromRms(rmsOf(data)));
      } else if (!recorder.current && !demoMode.current) bus.emit("level", 0);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [bus, player]);

  // Demo: open the page with ?demo=robot to see every state and mood in turn (no backend needed).
  useEffect(() => {
    if (!health || new URLSearchParams(location.search).get("demo") !== "robot") return;
    const steps: [string, string | null][] = [
      ["idle", null], ["listening", null], ["thinking", null], ["speaking", "happy"], ["idle", "happy"],
      ["idle", "curious"], ["idle", "concerned"], ["idle", "playful"], ["idle", "surprised"], ["idle", "excited"],
      ["idle", "sad"], ["error", null],
    ];
    demoMode.current = true;
    let index = 0;
    const show = () => {
      const [state, mood] = steps[index % steps.length];
      bus.emit("state", state);
      if (mood) bus.emit("expression", mood);
      document.title = `demo: ${state}${mood ? " + " + mood : ""}`;
      index += 1;
    };
    show();
    const a = setInterval(show, 2600);
    // A fake voice/mic level so listening and speaking move.
    const b = setInterval(() => bus.emit("level", 0.35 + 0.35 * Math.sin(performance.now() / 120) * Math.sin(performance.now() / 47)), 50);
    return () => { clearInterval(a); clearInterval(b); demoMode.current = false; };
  }, [health, bus]);

  // --- push-to-talk ----------------------------------------------------------------------------------
  // The mic is recorded as raw samples and sent as a 16-bit WAV clip; the server resamples it.
  const previewWords = useCallback(async (chunks: Float32Array[], rate: number, final = false): Promise<string | null> => {
    if (!chunks.length) return null;
    const seq = ++previewSeq.current;
    try {
      const response = await fetch(companionUrl("/v1/stt"), { method: "POST", headers: { "Content-Type": "audio/wav" }, body: encodeWav(chunks.slice(), rate) });
      if (!response.ok) return null;
      const heard = await response.json() as { text?: string };
      if (seq !== previewSeq.current || (!recorder.current && !final && !pendingVoice.current)) return null;   // a newer result, or already sent
      if (heard.text) setInput(heard.text);
      return heard.text || null;
    } catch { return null; /* the next try will catch up */ }
  }, []);

  const stopRecording = useCallback(async (): Promise<string | null> => {
    const r = recorder.current;
    if (!r) return null;
    recorder.current = null;
    clearTimeout(r.timer); clearInterval(r.preview);
    r.source.disconnect(); r.node.disconnect(); r.stream.getTracks().forEach((track) => track.stop()); await r.context.close();
    setRecording(null);
    bus.emit("level", 0);
    bus.emit("state", "idle");
    if (!r.chunks.length) { setHearing(false); setPlaceholder(TEXT_PLACEHOLDER); return null; }
    // ■ only stops: the final words go into the bar, and Send sends them with the recording (for voice cues).
    pendingVoice.current = { wav: encodeWav(r.chunks, r.rate), mode: r.mode, interrupted: r.interrupted, gapMs: r.gapMs };
    setPlaceholder("Fix the words if needed, then press Send");
    const words = await previewWords(r.chunks, r.rate, true);
    textBox.current?.focus();
    return words;
  }, [bus, previewWords]);

  const startRecording = useCallback(async (mode: string) => {
    const interrupted = player.talking();
    player.stop();  // barge-in: talking over Umbrella stops its voice
    const startedAt = performance.now();
    const gapMs = !interrupted && player.endedAt !== null ? Math.round(startedAt - player.endedAt) : null;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const node = context.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    node.onaudioprocess = (event) => {
      const samples = new Float32Array(event.inputBuffer.getChannelData(0));
      chunks.push(samples);
      bus.emit("level", levelFromRms(rmsOf(samples)));   // the robot listens to your voice
    };
    bus.emit("state", "listening");
    source.connect(node); node.connect(context.destination);
    pendingVoice.current = null;
    setInput(""); setHearing(true); setPlaceholder("Listening… your words appear here");
    recorder.current = {
      stream, context, source, node, chunks, rate: context.sampleRate, mode, interrupted, gapMs,
      timer: setTimeout(() => { stopRecording(); }, 60000),
      // Your words so far, every 1.5 s, into the input bar (speech to text only: nothing is sent or saved).
      preview: setInterval(() => { previewWords(chunks, context.sampleRate); }, 1500),
    };
    setRecording(mode);
  }, [bus, player, previewWords, stopRecording]);

  const micClick = (mode: string) => {
    if (recorder.current) { if (recorder.current.mode === mode) stopRecording(); return; }  // the other button is recording: ignore
    startRecording(mode).catch((error: Error) => add({ role: "assistant", text: "Mic not available: " + error.message, expression: "concerned" }));
  };

  const sendVoice = useCallback(async (wav: Blob, { mode, interrupted, gapMs, text }: { mode: string; interrupted: boolean; gapMs: number | null; text: string }) => {
    setMicBusy(true);
    const listening = add({ role: "user", text: MIC_BUTTONS[mode] + " …" });
    const controller = new AbortController();
    const turn: { out: string | null; userRow: string | null; tts: string } = { out: null, userRow: null, tts: "" };   // filled in as events arrive
    const started = performance.now();
    try {
      let url = `/v1/voice/stream?user_id=${encodeURIComponent(userRef.current)}&thread=${threadRef.current}&speed=${speedRef.current}&mode=${mode}&interrupted=${interrupted}`;
      if (gapMs !== null) url += `&gap_ms=${gapMs}`;
      if (text) url += `&text=${encodeURIComponent(text)}`;   // the words you confirmed in the bar
      player.setAbort(controller);
      await streamPost<StreamEvent>(url, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav, signal: controller.signal }, (event) => {
        if (event.type === "heard") {
          const heard = event.turn;
          remove(listening);
          if (!heard.kept) {
            turn.userRow = add({ role: "user", text: heard.heard ? `“${heard.heard}”` : "(kuch sunai nahi diya)", heard });
            add({ role: "assistant", text: "Sorry, theek se sunai nahi diya. Phir se bologe? (" + heard.reason + ")", expression: "concerned" });
          } else {
            turn.userRow = add({ role: "user", text: heard.heard, heard });
            turn.out = add({ role: "assistant", text: "", expression: "idle", thinking: true });
          }
          setMicBusy(false);  // you may talk over the reply now (barge-in)
        } else if (event.type === "error") throw new Error(event.error);
        else if (event.type === "request") attach(turn.userRow, "sent to backend", event.object);
        else if (event.type === "response") attach(turn.out || turn.userRow, "backend response", event.object);
        else if (!turn.out) return;
        else if (event.type === "delta") update(turn.out, (m) => ({ ...m, thinking: false, text: m.text + event.text }));
        else if (event.type === "expression") { update(turn.out, (m) => ({ ...m, expression: event.expression })); bus.emit("expression", event.expression); }
        else if (event.type === "audio") { turn.tts = event.tts_provider; player.enqueue(b64ToWav(event.wav_b64)); }
        else if (event.type === "done" && event.reply) {
          const reply = event.reply;
          tokenStore.count(reply.usage);
          update(turn.out, (m) => ({ ...m, thinking: false, text: reply.text || m.text, expression: reply.expression, reply,
            extra: ["🔊 " + (turn.tts || "no voice"), "total " + ((performance.now() - started) / 1000).toFixed(1) + " s"] }));
        }
      });
    } catch (error) {
      remove(listening);
      if ((error as Error).name !== "AbortError") { add({ role: "assistant", text: "Voice error: " + (error as Error).message, expression: "concerned" }); bodyError(); }
    } finally {
      player.clearAbort(controller);
      if (!player.busy() && !player.queue.length && !recorder.current) bus.emit("state", "idle");
      setMicBusy(false);
      refreshPanels();
    }
  }, [add, attach, bodyError, bus, player, refreshPanels, remove, update]);

  // --- typed messages ------------------------------------------------------------------------------
  const submit = useCallback(async (given?: string) => {
    // Send while still recording: stop, then send what was said.
    const words = recorder.current ? await stopRecording() : null;
    const text = (given === undefined && words ? words : given ?? inputRef.current).trim();
    if (!text) return;
    setInput(""); setHearing(false); setPlaceholder(TEXT_PLACEHOLDER);
    if (pendingVoice.current) {
      // A push-to-talk recording: send the audio (for voice cues) with the words as you confirmed them.
      const voice = pendingVoice.current; pendingVoice.current = null;
      bus.emit("state", "thinking");
      await sendVoice(voice.wav, { mode: voice.mode, interrupted: voice.interrupted, gapMs: voice.gapMs, text });
      return;
    }
    setSending(true);
    const userRow = add({ role: "user", text });
    const out = add({ role: "assistant", text: "", expression: "idle", thinking: true });
    bus.emit("state", "thinking");
    try {
      await streamPost<StreamEvent>("/v1/chat/stream", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userRef.current, text, thread: threadRef.current }),
      }, (event) => {
        if (event.type === "request") attach(userRow, "sent to backend", event.object);
        else if (event.type === "response") attach(out, "backend response", event.object);
        else if (event.type === "delta") update(out, (m) => ({ ...m, thinking: false, text: m.text + event.text }));
        else if (event.type === "expression") { update(out, (m) => ({ ...m, expression: event.expression })); bus.emit("expression", event.expression); }
        else if (event.type === "done" && event.reply) {
          // The checked final text: the same words, unless a filter dropped a sentence; line breaks kept.
          const reply = event.reply;
          tokenStore.count(reply.usage);
          update(out, (m) => ({ ...m, thinking: false, text: reply.text || m.text, expression: reply.expression, reply }));
          bus.emit("state", "idle");
        }
      });
    } catch (error) {
      remove(out);
      add({ role: "assistant", text: "Error: " + (error as Error).message, expression: "concerned" });
      bodyError();
    } finally {
      setSending(false);
      textBox.current?.focus();
      loadThreads(userRef.current, threadRef.current);
      refreshPanels();
    }
  }, [add, attach, bodyError, bus, loadThreads, refreshPanels, remove, sendVoice, stopRecording, update]);

  // --- Live voice (LiveKit) --------------------------------------------------------------------------
  // The server starts Umbrella in a LiveKit room and returns a token; the browser joins with its mic.
  // Umbrella sends small JSON messages: captions, its expression and its state.
  const onLiveMessage = useCallback((payload: Uint8Array) => {
    let message: LiveMessage;
    try { message = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
    if (message.type === "turn_objects") {   // sent after each live turn
      attach(message.request?.text ? lastLiveUser.current : lastLiveBot.current, "sent to backend", message.request);
      attach(lastLiveBot.current, "backend response", message.response);
      const usage = message.response?.usage;
      if (usage && usage.calls && lastLiveBot.current) {   // live replies get their token line here
        update(lastLiveBot.current, (m) => ({ ...m, usage }));
        tokenStore.count(usage);
      }
    } else if (message.type === "caption_partial") {   // your words so far in this turn: shown in the input bar
      setInput(message.text || "");
      setHearing(true);
    } else if (message.type === "caption_delta") {   // Umbrella's words as the model writes them
      if (!liveReply.current) liveReply.current = add({ role: "assistant", text: "", expression: liveExpression.current, thinking: true, plain: true });
      update(liveReply.current, (m) => ({ ...m, thinking: false, text: m.text + (message.text || "") }));
    } else if (message.type === "caption" && message.text) {
      const text = message.text;
      if (message.role === "user") {
        lastLiveUser.current = add({ role: "user", text });
        setInput(""); setHearing(false);   // sent: the bar is free again
      } else if (liveReply.current) {
        const id = liveReply.current;
        update(id, (m) => ({ ...m, thinking: false, text, expression: liveExpression.current, places: true }));
        lastLiveBot.current = id;
        liveReply.current = null;
      } else lastLiveBot.current = add({ role: "assistant", text, expression: liveExpression.current });
    } else if (message.type === "expression" && message.expression) {
      liveExpression.current = message.expression;
      setLiveFace(message.expression);
      bus.emit("expression", message.expression);
    } else if (message.type === "state" && message.state) {
      setLiveState(STATES[message.state] || message.state);
      bus.emit("state", message.state);
    } else if (message.type === "safety_resources" && message.resources) {
      toast("Support: " + message.resources.map((r) => `${r.name} ${r.phone}`).join(" · "));
    }
  }, [add, attach, bus, toast, update]);

  const endLive = useCallback(async (disconnect = true) => {
    const current = liveRoom.current;
    if (!current) return;
    liveRoom.current = null;
    if (disconnect) await current.room.disconnect();
    setHearing(false);
    document.querySelectorAll("audio[data-live]").forEach((node) => node.remove());
    if (liveAnalyser.current) { liveAnalyser.current.ctx?.close().catch(() => {}); liveAnalyser.current = null; }
    bus.emit("state", "idle");
    setLive(false);
    setLiveBar(false);
    postJson("/v1/live/stop", { room: current.name }).catch(() => {});
    setRefreshKey((n) => n + 1);
  }, [bus]);

  const startLive = useCallback(async () => {
    setLiveStarting(true);
    setLiveBar(true); setLiveState("starting Umbrella…");
    let room: Room | null = null;
    let session: { room: string; url: string; token: string } | null = null;
    try {
      const LK = await import("livekit-client");
      // Ask for the mic first, so a refusal never leaves Umbrella waiting in an empty room.
      (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
      session = await postJson<{ room: string; url: string; token: string }>("/v1/live/start", { user_id: userRef.current });
      room = new LK.Room({ audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      room.on(LK.RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== LK.Track.Kind.Audio) return;
        const element = track.attach(); element.dataset.live = "1"; document.body.append(element);
        // Umbrella's voice level for the robot's mouth.
        try {
          const ctx = new AudioContext();
          const analyser: AnalyserNode & { ctx?: AudioContext } = ctx.createAnalyser();
          analyser.fftSize = 512;
          ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack])).connect(analyser);
          analyser.ctx = ctx;
          liveAnalyser.current = analyser;
        } catch { liveAnalyser.current = null; }
      });
      room.on(LK.RoomEvent.DataReceived, onLiveMessage);
      room.on(LK.RoomEvent.Disconnected, () => { endLive(false); });
      await room.connect(session.url, session.token);
      await room.localParticipant.setMicrophoneEnabled(true);
      liveRoom.current = { room, name: session.room };
      setLiveSince(Date.now() / 1000);
      setLive(true);
      setLiveState("connected: Umbrella will greet you");
    } catch (error) {
      setLiveBar(false);
      if (room) room.disconnect();
      if (session) postJson("/v1/live/stop", { room: session.room }).catch(() => {});
      add({ role: "assistant", text: "Live voice error: " + (error as Error).message, expression: "concerned" });
    } finally {
      setLiveStarting(false);
    }
  }, [add, endLive, onLiveMessage]);

  // --- header actions --------------------------------------------------------------------------------
  const onUserChange = (value: string) => {
    if (value === "__new__") {
      const name = (prompt("New user id (letters, numbers, - or _):") || "").trim();
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) { loadUsers(); return; }
      selectUser(name);
      return;
    }
    selectUser(value);
  };

  const newThread = async () => {
    // A separate chat with its own memory; the main thread stays exactly as it is.
    const { thread: made } = await api<{ thread: string }>(`${userPath(user)}/threads`, { method: "POST" });
    openThread(user, made);
  };

  const openTestChat = async (testUser: string, testThread: string) => {
    setTestOpen(false);
    store("companion.user", testUser);
    const chosen = await loadUsers(testUser);
    openThread(chosen, testThread);
  };

  const putExample = (text: string) => { setInput(text); textBox.current?.focus(); };

  return (
    <>
      <div className="app">
        <header>
          <h1>Companion Playground</h1>
          <label className="pick" title="Users in the database. Each user is separate.">
            <span>User</span>
            <select id="user" value={user} onChange={(e) => onUserChange(e.target.value)}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.threads ? `${u.id} · ${u.threads} thread${u.threads === 1 ? "" : "s"}` : `${u.id} · empty`}</option>
              ))}
              {!users.some((u) => u.id === user) && <option value={user}>{user}</option>}
              <option value="__new__">➕ New user…</option>
            </select>
          </label>
          {/* One consumer = one thread for now: the thread picker and "New thread" stay hidden (the backend still supports threads). */}
          <label className="pick" hidden title="This user's threads. Each thread has its own chat, memory, notes, reminders, to-dos and lists.">
            <span>Thread</span>
            <select id="threadSelect" value={thread} onChange={(e) => openThread(user, e.target.value)}>
              {threads.map((t) => (
                <option key={t.thread} value={t.thread} title={t.first_message ? `Starts with: “${t.first_message}”` : "Empty"}>
                  {`Thread ${t.number}${t.thread === "main" ? " · main" : ""} · ${t.messages} msgs`}
                </option>
              ))}
            </select>
          </label>
          <button type="button" hidden title="Open a new thread for this user. It starts empty: its own chat and memory." onClick={newThread}>＋ New thread</button>
          <button type="button" className={"live" + (live ? " on" : "")} disabled={!health?.live || liveStarting} title="Real-time voice: talk freely, interrupt any time"
            onClick={() => (liveRoom.current ? endLive() : startLive())}>{live ? "End live" : "📞 Live"}</button>
          <button type="button" className={"trace" + (traceOpen ? " on" : "")} title="See what the agent does at every step, and its memory"
            onClick={() => setTraceOpen(!traceOpen)}>🧠 Trace</button>
          <button type="button" className={"trace" + (testOpen ? " on" : "")} title="A simulated consumer chats with Umbrella in a new thread; see what goes to the LLM and what comes back"
            onClick={() => setTestOpen(true)}>🧪 Test</button>
          <span className="grow" />
          <label className="speed">Voice speed <input type="range" min={0.7} max={1.4} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} /> <span>{speed.toFixed(2) + "×"}</span></label>
          <span className="status" id="health">{status}</span>
        </header>

        <section className="chat">
          <Stage plugins={health?.plugins || []} bus={bus} />
          <div className={"livebar" + (liveBar ? " on" : "")}>
            <span className="big">{FACES[liveFace] || FACES.idle}</span><span>{liveState}</span>
            <span className="status">Use earphones so Umbrella doesn&apos;t hear itself.</span>
          </div>
          {liveSince !== null && <LiveLog key={liveSince} user={user} since={liveSince} listening={live} />}
          <ChatLog messages={messages} onSpeak={sayAloud} onPlace={(place) => submit(`Save it in ${place}.`)} onReminder={answerReminder} />
          <TokenBar />
          <form className="send" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <input id="text" ref={textBox} className={hearing ? "hearing" : ""} value={input} onChange={(e) => setInput(e.target.value)}
              placeholder={placeholder} autoComplete="off" required />
            <button type="button" className={"mic" + (recording === "push_to_talk" ? " recording" : "")} disabled={micBusy}
              title="Push-to-talk: click, speak, click again to send (words only)" onClick={() => micClick("push_to_talk")}>{recording === "push_to_talk" ? "■" : "🎤"}</button>
            <button type="button" className={"mic" + (recording === "push_to_talk_cues" ? " recording" : "")} disabled={micBusy}
              title="Push-to-talk with voice cues: like 🎤, plus how you sounded (pauses, pace, loudness...) goes to the LLM, like Live"
              onClick={() => micClick("push_to_talk_cues")}>{recording === "push_to_talk_cues" ? "■" : "🎙️✨"}</button>
            <button className="primary" disabled={sending}>Send</button>
          </form>
        </section>

        <SidePanel user={user} thread={thread} refreshKey={refreshKey} onExample={putExample} />
      </div>

      {traceOpen && <TracePanel user={user} thread={thread} refreshKey={refreshKey} onClose={() => setTraceOpen(false)} />}
      {testOpen && <TestPanel onClose={() => setTestOpen(false)} onOpenChat={openTestChat} />}
      {toasts.map((t) => <div key={t.id} className="toast">{"⏰ " + t.text}</div>)}
    </>
  );
}
