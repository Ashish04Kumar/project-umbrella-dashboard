import { ClientOnly } from "./client-only";

// The dashboard runs only in the browser (mic, audio, local storage), so the page just loads it there.
export default function Home() {
  return <ClientOnly />;
}
