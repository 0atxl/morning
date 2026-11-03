# Morning web workspace

React, Vite, TypeScript and official shadcn/ui Radix components. The guest dashboard opens at `/app`.

## Start locally

Use Node.js 22.12 or newer.

```bash
cd web
npm ci --ignore-scripts
npm run dev
```

Open `/app` on the URL Vite prints. For live commands, also start the [Go API](../server/README.md) from the same checkout with its server-side Deepgram and Groq keys. Vite proxies `/api` to `http://127.0.0.1:8080`. Production needs HTTPS and the same origin for the browser and API. Provider credentials never belong in a `VITE_` variable.

## Current checkpoint

The default guest workspace records real reminder and email-draft commands. On a mic click, it requests microphone permission, obtains a temporary Deepgram token and streams containerized microphone audio with live interim captions. Pauses do not submit commands. On Stop, it flushes MediaRecorder's final audio chunk, sends Deepgram's `CloseStream` message and waits for final results, summary metadata and a clean connection close. It then posts the combined final transcript once to `/api/commands`.

A draft, a reminder, or both commit in one IndexedDB transaction with a unique command receipt. After a new commit, Morning posts a short confirmation to `/api/speech` and plays the returned ElevenLabs MP3. Browser speech provides a fallback. If playback is blocked, **Play reply** retries the audio. Replaying a command, selecting a session and refreshing the page never trigger a new spoken confirmation.

**History** selects a conversation. **New session** starts an empty one. Each recording keeps its original session ID through processing and retries. The selected session, finalized transcripts, saved results and edits stay in IndexedDB. Records saved before sessions were introduced appear under **Earlier activity**.

Open a saved row for Quick View. Escape or Space closes it and returns focus to the row. Left and right arrows browse results in the selected session when focus is outside an editable field.

On failure, captured words stay visible with **Retry**. A transcription retry replays retained audio with a fresh token. A command retry keeps its original ID, transcript, timestamp, timezone, contacts and selected contact. After interpretation succeeds, a failed save retries storage. Missing-time clarification asks for a complete revised recording.

Click the orb, mic or **Talk to Morning** label to start hands-free recording. Click **Stop listening** to finish. On a focused dashboard, **Hold Right Ctrl to talk** starts on physical right-Control keydown and finishes on release. A release only ends the recording owned by that hold. Releasing during microphone permission or connection startup cancels it. Losing focus cancels a held recording. Editors, dialogs, held modifier chords and key repeats cannot start another recording. Left Ctrl and ordinary keyboard shortcuts keep their defaults.

The History and Activity panels start closed. Activity opens when a finalized command starts processing. Closing it keeps it closed for that request. Its ASCII animation follows the current operation and shows “Speaking” when playback starts.

The glass orb measures volume from the recording stream. Its inner colors swell with speech and settle during pauses. Captions sit below the mic control. Reduced motion keeps the colored listening state and plain captions.

The client accepts at most one `create_reminder` and one `draft_email` action, or zero actions with a clarification. It validates the complete response before any save. Browser integration for reminder corrections, calendar events and meeting minutes is pending. Reminder alerts and background notifications are also pending. The landing page opens at `/`, and **Try Morning** links to `/app`. This frontend change has not been exercised with a browser, mic or live provider.

## Guest contacts and drafts

Try the command "Draft Priya an email asking her to confirm the revised timeline." The guest address book starts with clearly labeled example contacts for Priya Shah at `priya.shah@example.com` and Alex Chen at `alex.chen@example.com`. Open **Contacts** at the bottom to add a missing name and address. Contacts stay in IndexedDB; only matching name records are sent with a voice command.

If two contacts match, choose from the names and addresses shown below the transcript. That selection reuses the pending command ID, transcript, original time, timezone and contact snapshot. Adding a missing contact instead requires a complete revised recording with a new ID. Neither path saves a partial draft or reminder while awaiting clarification.

Quick View shows the recipient, subject and editable message. **Send via Gmail** opens a compose window with the saved recipient, subject and body. Review the message and send it in Gmail. Copy and plain-text download are also available. Existing draft edits remain intact on a command replay.

## Build commands

```bash
npm run check
npm run build
```

`check` runs TypeScript. `build` runs TypeScript and compiles with Vite. Neither executes tests. `npm run format` formats source files with Prettier.

Tests, manual browser QA, smoke checks, provider probes and CI execution require the user's explicit confirmation for each run. The Node fixture cases in `tests/` cover transcript finalization, draft-only and combined commands, contact selection, version-1 upgrades, atomic rollback, concurrent saves, replay after editing, contact persistence and physical Right Ctrl hold/release handling. They have not run. `fake-indexeddb` is a test-only dependency for isolated in-memory storage cases; it is not included in the application bundle. No automatic test workflow is added. Any proposed browser or provider run must identify its cases, revision and live provider use before approval.

Shared UI components live in `src/components/ui/`. They come from the [official shadcn/ui New York registry](https://ui.shadcn.com/docs/components/radix/button), with Morning's styles and motion choices. Their MIT notice is included in that directory. Fonts are served locally from the installed package.
