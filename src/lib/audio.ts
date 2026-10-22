// Umbrella's voice and the mic: WAV helpers, the sentence-by-sentence player, and loudness for the robot.
import { companionUrl } from "./api";

// Loudness (RMS of -1..1 samples) to 0..1, like the app's mic meter: normal speech fills most of the range.
export const levelFromRms = (rms: number) => Math.min(1, Math.max(0, (20 * Math.log10(Math.max(rms, 1e-6)) + 50) / 42));

export const rmsOf = (samples: Float32Array) => {
  let sum = 0;
  for (const v of samples) sum += v * v;
  return Math.sqrt(sum / samples.length);
};

// Umbrella's voice level for the robot's mouth: computed from each WAV (20 ms steps) and read while it plays.
async function voiceEnvelope(blob: Blob): Promise<number[] | null> {
  try {
    const buffer = await blob.arrayBuffer();
    const view = new DataView(buffer);
    const rate = view.getUint32(24, true);
    const samples = new Int16Array(buffer, 44, Math.floor((buffer.byteLength - 44) / 2));
    const step = Math.max(1, Math.round(rate * 0.02));
    const env: number[] = [];
    for (let i = 0; i < samples.length; i += step) {
      let sum = 0;
      const end = Math.min(samples.length, i + step);
      for (let j = i; j < end; j++) { const v = samples[j] / 32768; sum += v * v; }
      env.push(levelFromRms(Math.sqrt(sum / (end - i))));
    }
    return env;
  } catch {
    return null;
  }
}

export function encodeWav(chunks: Float32Array[], rate: number): Blob {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const view = new DataView(new ArrayBuffer(44 + length * 2));
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + length * 2, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (let i = 0; i < chunk.length; i++, offset += 2) {
    view.setInt16(offset, Math.max(-1, Math.min(1, chunk[i])) * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}

export const b64ToWav = (b64: string) => new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "audio/wav" });

type Playing = HTMLAudioElement & { env?: number[] | null };

/**
 * Umbrella's voice arrives one sentence at a time: play them in order. Also remembers when Umbrella last
 * stopped talking (for the "pause before answering" voice cue) and holds the abort controller of a
 * push-to-talk reply that is still streaming, so talking over Umbrella can stop it (barge-in).
 */
export class VoicePlayer {
  player: Playing | null = null;
  queue: Blob[] = [];
  abort: AbortController | null = null;
  endedAt: number | null = null;

  private isRecording: () => boolean = () => false;

  constructor(private onState: (state: string) => void) {}

  setRecordingCheck(check: () => boolean) {
    this.isRecording = check;
  }

  // A push-to-talk reply that is still streaming: `stop()` aborts it (barge-in).
  setAbort(controller: AbortController) {
    this.abort = controller;
  }

  clearAbort(controller: AbortController) {
    if (this.abort === controller) this.abort = null;
  }

  busy() {
    return Boolean(this.player && !this.player.paused && !this.player.ended);
  }

  // Umbrella counts as talking while a sentence plays, more are queued, or the reply is still streaming.
  talking() {
    return this.busy() || this.queue.length > 0 || this.abort !== null;
  }

  level(): number | null {
    if (!this.player || !this.busy() || !this.player.env) return null;
    return this.player.env[Math.floor(this.player.currentTime / 0.02)] || 0;
  }

  stop() {
    this.queue.length = 0;
    if (this.abort) { this.abort.abort(); this.abort = null; }
    if (this.player) {
      if (this.busy()) this.endedAt = performance.now();
      this.player.pause();
      this.player = null;
    }
  }

  private next() {
    const blob = this.queue.shift();
    if (!blob) {
      this.player = null;
      if (!this.abort && !this.isRecording()) this.onState("idle");   // Umbrella finished talking
      return;
    }
    const audio: Playing = new Audio(URL.createObjectURL(blob));
    this.player = audio;
    voiceEnvelope(blob).then((env) => { audio.env = env; });
    audio.onplay = () => this.onState("speaking");
    audio.onended = () => { this.endedAt = performance.now(); this.next(); };
    audio.play().catch(() => this.next());
  }

  enqueue(blob: Blob) {
    this.queue.push(blob);
    if (!this.busy()) this.next();
  }

  play(blob: Blob) {
    this.stop();
    this.enqueue(blob);
  }

  async say(text: string, speed: number) {
    const response = await fetch(companionUrl("/v1/tts"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, speed }),
    });
    if (response.ok) this.play(await response.blob());
  }
}
