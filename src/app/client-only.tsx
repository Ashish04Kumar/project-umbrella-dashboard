"use client";
import dynamic from "next/dynamic";

// ssr: false: the playground uses the mic, audio and localStorage, which exist only in the browser.
const Playground = dynamic(() => import("@/components/Playground"), { ssr: false });

export function ClientOnly() {
  return <Playground />;
}
