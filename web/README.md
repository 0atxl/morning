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

A draft alone, a reminder alone, or one of each commits in one IndexedDB transaction with a unique command receipt. Saved rows and Quick View appear after that commit. Browser speech says "Draft saved" and names a reminder's due time when present. Records and manual edits survive refresh in the same browser profile and origin. Replaying a command reuses its saved records, preserves edits and does not speak another success. The version-2 database adds drafts and contacts without replacing existing reminders or receipts.

On failure, captured words stay visible with Retry. A transcription retry replays retained audio with a fresh token. A command retry keeps its original ID, transcript, timestamp, timezone, contacts and selected contact. After interpretation succeeds, a failed save retries storage without calling the command API again. Retry-After delays are honored. A failed spoken confirmation has a separate Retry speech control that does not recreate any records. Missing-time clarification asks for a complete revised recording.

History and Activity start closed. Quick View supports editing, copy and plain-text download. Escape or Space closes it, and left/right arrows browse results outside editable fields. Closing restores focus to the opening row, or to the mic after an automatic opening for a saved command.

Click the orb, mic or **Talk to Morning** label to start hands-free recording. Click **Stop listening** to finish. On a focused dashboard, **Hold Right Ctrl to talk** starts on physical right-Control keydown and finishes on release. A release only ends the recording owned by that hold. Releasing during microphone permission or connection startup cancels it. Losing focus cancels a held recording. Editors, dialogs, held modifier chords and key repeats cannot start another recording. Left Ctrl and ordinary keyboard shortcuts keep their defaults.

History and Activity are independent layout panels. On desktop they occupy the left and right columns. On narrow screens Activity is compact above the workspace, and History is below it. Activity opens once when a finalized command starts processing, without moving focus. Closing it leaves it closed for that command, including retries. The next command can open it again.

The glass orb keeps its center clear, with the mic and label beside it. Captions appear once below it. Only the newest eight characters resolve from dots, then become fully readable even when speech pauses. The original transcript remains available to assistive technology and to the command flow. Reduced motion shows static shapes and plain text.

Activity's ORB is idle or awaiting interpretation, STT follows capture and finalization, MAIL follows validated draft/contact results, and DIAL follows a validated reminder or its spoken confirmation. A draft and reminder still save atomically and are grouped together in Activity. PAD and PEN are labeled Design preview only until meeting minutes and corrections are connected. The rail lists alternative states, not a six-step progress sequence. The shape animation stops when Activity is closed or the page is hidden.

**Design preview** contains the isolated sample ready, listening, processing, saved, clarification, error and empty states. Choose **Guest workspace** to return to live commands. Fixtures in `src/fixtures/` never call providers or write to IndexedDB. Their edits reset on reload, and `priya@example.test` is a sample contact.

For a visual review without providers, choose **Design preview → Ready** or **Listening**, then open Activity. Its ORB, STT, PAD, PEN, MAIL and DIAL buttons preview each shape independently. **Follow preview state** returns the panel to the selected sample state. These controls never change live execution status.

The client accepts at most one `create_reminder` and one `draft_email` action, or zero actions with a clarification. It validates the complete response before any save. Browser integration for reminder corrections, calendar events, meeting minutes and ElevenLabs playback is pending. Reminder alerts and background notifications are also pending. The landing page opens at `/`, and **Try Morning** links to `/app`. This frontend change has not been exercised with a browser, mic or live provider.

## Guest contacts and drafts

Try the command "Draft Priya an email asking her to confirm the revised timeline." The guest address book starts with clearly labeled example contacts for Priya Shah at `priya.shah@example.com` and Alex Chen at `alex.chen@example.com`. Open **Contacts** at the bottom to add a missing name and address. Contacts stay in IndexedDB; only matching name records are sent with a voice command.

If two contacts match, choose from the names and addresses shown below the transcript. That selection reuses the pending command ID, transcript, original time, timezone and contact snapshot. Adding a missing contact instead requires a complete revised recording with a new ID. Neither path saves a partial draft or reminder while awaiting clarification.

Quick View shows the recipient, subject and editable message. Email delivery is unavailable. The user can copy or download the saved draft. There is no mailbox sign-in, sending endpoint or additional provider. Existing draft edits remain intact on a command replay.

## Build commands

```bash
npm run check
npm run build
```

`check` runs TypeScript. `build` runs TypeScript and compiles with Vite. Neither executes tests. `npm run format` formats source files with Prettier.

Tests, manual browser QA, smoke checks, provider probes and CI execution require the user's explicit confirmation for each run. The Node fixture cases in `tests/` cover transcript finalization, draft-only and combined commands, contact selection, version-1 upgrades, atomic rollback, concurrent saves, replay after editing, contact persistence and physical Right Ctrl hold/release handling. They have not run. `fake-indexeddb` is a test-only dependency for isolated in-memory storage cases; it is not included in the application bundle. No automatic test workflow is added. Any proposed browser or provider run must identify its cases, revision and live provider use before approval.

Shared UI components live in `src/components/ui/`. They come from the [official shadcn/ui New York registry](https://ui.shadcn.com/docs/components/radix/button), with Morning's styles and motion choices. Their MIT notice is included in that directory. Fonts are served locally from the installed package.
