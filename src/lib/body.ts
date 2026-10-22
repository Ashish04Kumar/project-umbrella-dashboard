// Body bus: front-end plugins (the 3D robot) listen to what Umbrella is doing.
// Events: "state" (idle | listening | thinking | speaking | error), "expression" (reply mood), "level" (0..1).

type Handler = (value: unknown) => void;

export type BodyBus = {
  on(type: string, fn: Handler): () => void;
  emit(type: string, value: unknown): void;
};

export function createBodyBus(): BodyBus {
  const handlers: Record<string, Set<Handler>> = {};
  return {
    on(type, fn) {
      (handlers[type] ||= new Set()).add(fn);
      return () => handlers[type].delete(fn);
    },
    emit(type, value) {
      for (const fn of handlers[type] || []) {
        try { fn(value); } catch (error) { console.error("plugin", error); }
      }
    },
  };
}

export const FACES: Record<string, string> = { happy: "😊", curious: "🤔", concerned: "🫂", playful: "😜", idle: "🙂" };
export const face = (expression?: string) => FACES[expression || "idle"] || FACES.idle;
