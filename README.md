# umbrella-d

The dashboard for the companion (Umbrella) in `companion-umbrella` (folder `/home/bs/projects/umbrella`),
as its own Next.js app. It is the companion server's built-in playground (`companion/server/playground.html`)
moved to React, with the same features:

- chat that streams Umbrella's reply as it is written, with the details under each reply (mood, time, model,
  tokens, tools, sources), the `{ }` raw request/response objects, and "Where should I save" buttons;
- the 🪙 Tokens bar (Start / Stop / Reset) adding up input and output tokens;
- push-to-talk (🎤 words only, 🎙️✨ with voice cues): your words appear in the box as you talk, Send sends;
- 📞 Live voice over LiveKit, with the turn-taking log;
- the side tabs (Long-term, Short-term, Notes, Reminders, To-dos, Lists, Chat) with "What to say", edit,
  delete and clear;
- due reminders: a toast, spoken aloud, with Done and 10-minute snooze;
- 🧠 Trace (memory columns and database rows, live) and 🧪 Test (the simulated consumer);
- the 3D robot (when the server switches the `robot` plugin on), and `?demo=robot`.

It has no backend of its own: the browser calls the companion server's HTTP API directly (JSON, replies
streamed as server-sent events over POST, `EventSource` for the live trace).

## Run

1. Start the companion server (it must allow this dashboard's address, see below):

   ```bash
   cd /home/bs/projects/umbrella && .venv/bin/python -m companion.server --port 8300
   ```

2. Start the dashboard and open http://localhost:3200:

   ```bash
   cd /home/bs/projects/umbrella-d && npm run dev
   ```

## Settings

- `NEXT_PUBLIC_COMPANION_URL` in `.env.local` (copy `.env.example`): where the companion server is,
  default `http://127.0.0.1:8300`. It is built into the page, so restart `npm run dev` after changing it.
- On the server, `COMPANION_CORS_ORIGINS` in the companion's `.env` lists the pages allowed to call it;
  the default allows `http://localhost:3200` and `http://127.0.0.1:3200`.

Both run on this laptop only: the server has no login, and the dashboard shows real chats.

## Checks

```bash
npm run typecheck
npm run lint
npm run build
```

## Where things are

- `src/components/Playground.tsx`: the page: header, chat, sending, push-to-talk, Live, reminders.
- `src/components/ChatLog.tsx`, `TokenBar.tsx`, `SidePanel.tsx`, `TracePanel.tsx`, `TestPanel.tsx`,
  `LiveLog.tsx`, `Stage.tsx`: the parts of the page.
- `src/lib/api.ts`: the server address, JSON calls, the stream reader, and the shapes the server sends.
- `src/lib/audio.ts`: WAV encoding and Umbrella's voice player. `src/lib/tokens.ts`: the token counter.
- `src/plugins/robot.js` and `public/plugins/robot/gg2-head.glb`: the 3D robot, copied unchanged from the
  companion (three.js now comes from npm).
- `src/app/globals.css`: the playground's styles, unchanged.
