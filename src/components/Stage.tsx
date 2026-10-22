"use client";
// The stage above the chat: front-end plugins the server switched on (COMPANION_UI_PLUGINS) are drawn
// here. Each plugin gets its own box and the body bus. Today there is one: the 3D robot.
import { useEffect, useRef, useState } from "react";
import type { BodyBus } from "@/lib/body";

type Mounted = { unmount(): void };
const PLUGINS: Record<string, () => Promise<{ mount(box: HTMLElement, bus: BodyBus): Mounted }>> = {
  robot: () => import("@/plugins/robot"),
};

export function Stage({ plugins, bus }: { plugins: string[]; bus: BodyBus }) {
  const stage = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  const names = plugins.filter((name) => PLUGINS[name]).join(",");

  useEffect(() => {
    if (!names || !stage.current) return;
    const root = stage.current;
    const mounted: Mounted[] = [];
    let cancelled = false;
    (async () => {
      for (const name of names.split(",")) {
        try {
          const plugin = await PLUGINS[name]();
          if (cancelled) return;
          const box = document.createElement("div");
          root.append(box);
          mounted.push(plugin.mount(box, bus));
          setOn(true);
        } catch (error) {
          console.error(`plugin ${name} failed`, error);
        }
      }
    })();
    return () => {
      cancelled = true;
      mounted.forEach((m) => m.unmount());
      root.textContent = "";
    };
  }, [names, bus]);

  return <div className={"stage" + (on ? " on" : "")} id="stage" aria-label="Umbrella" ref={stage} />;
}
