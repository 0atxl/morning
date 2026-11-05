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

A draft, a reminder, or both commit in one IndexedDB transaction with a unique command receipt. A spoken reminder correction or email revision updates the existing item with its own receipt. Draft revisions preserve the recipient and related reminder. Stale snapshots and cross-conversation updates abort. After a new commit, Morning posts a short confirmation to `/api/speech` and attempts the returned ElevenLabs MP3. Browser speech provides a fallback. **Play reply** remains available for the current reply even without a reported playback error. A manual attempt supersedes pending automatic playback. Replaying a command, selecting a session and refreshing the page never trigger a new spoken confirmation.

**History** selects a conversation. **New session** starts an empty one. Each recording keeps its original session ID and item snapshots through processing and retries. The selected session, finalized transcripts, generated conversational replies, saved results and edits stay in IndexedDB. Greetings and capability questions use Groq rather than fixed phrase responses. They save a conversation reply and create no reminder or draft. Records saved before sessions were introduced appear under **Earlier activity**.

Open a saved row for Quick View. Escape or Space closes it and returns focus to the row. Left and right arrows browse results in the selected session when focus is outside an editable field.

On failure, captured words stay visible with **Retry**. A transcription retry replays retained audio with a fresh token. A command retry keeps its original ID, transcript, timestamp, timezone, contacts and selected contact. After interpretation succeeds, a failed save retries storage. Missing-time clarification asks for a complete revised recording.

Click the orb, mic or **Talk to Morning** label to start hands-free recording. Click **Stop listening** to finish. On a focused dashboard, **Hold Right Ctrl to talk** starts on physical right-Control keydown and finishes on release. A release only ends the recording owned by that hold. Releasing during microphone permission or connection startup cancels it. Losing focus cancels a held recording. Editors, dialogs, held modifier chords and key repeats cannot start another recording. Left Ctrl and ordinary keyboard shortcuts keep their defaults.

The History and Activity panels start closed. Activity opens when a finalized command starts processing. Closing it keeps it closed for that request. Its ASCII animation follows the current operation and shows “Speaking” when playback starts.

The glass orb measures volume from the recording stream. Its inner colors swell with speech and settle during pauses. Captions sit below the mic control. Reduced motion keeps the colored listening state and plain captions.

The client accepts one new reminder, one new draft, both together, one `reschedule_reminder`, one `update_draft`, a conversational reply, or a clarification. Updates cannot be combined with other saved actions. The sole reminder and draft in the recording's conversation supply context; with multiple possible targets, the user chooses a snapshot for the original request. New email drafts are prompted to be developed and grounded in supplied facts. The app limits allow 30 mic starts, 60 commands and 60 speech requests per public IP per minute, within global caps of 300, 600 and 600. The frontend reports HTTP status for a non-JSON proxy failure, and provider HTTP 429 has its own error category. Increasing app limits does not change provider account quotas.

Reminder Quick View offers Download .ics and Add to Google Calendar. Both create a one-minute marker at the saved due instant; the user imports or saves it. Calendar copies do not sync with later edits. The export follows [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545) and the link follows [Google's event-template format](https://developers.google.com/workspace/calendar/api/concepts/inviting-attendees-to-events). Spoken event commands save only the start as a reminder; the event end is not retained and full-duration scheduling is not available.

Due alerts stay in browser storage until dismissed. Only a focused, visible tab with audio enabled claims the automatic chime; Play chime is also available. Paired owner browsers can schedule private Gmail reminders. Email status announces acceptance only after a fresh queue read finds no pending revisions. The landing page opens at `/`, Try Morning links to `/app`, and Presentation opens `/presentation.html`. Local packaged installation and phone sync remain plans. These changes have not been exercised with a browser, mic or live provider.

## Meeting minutes

Open **Meeting minutes** to paste notes or a completed spoken transcript and choose English or Hindi. For dictation, begin with "Take meeting minutes" or "Take meeting minutes in Hindi", dictate the discussion, then stop. This submits one completed transcript. Morning does not continuously record meetings or capture remote participants.

Discussion is data. Reminder, email and download instructions inside it do not execute. The browser validates the direct minutes response before saving. Requests are limited to 64 KiB including JSON encoding, with no silent shortening. Each section allows 20 entries. Summary text allows 800 Unicode characters, tasks/decisions/questions 500, and nullable owner/deadline text 200.

Quick View edits all four sections. Save changes before playback, copying, text download, Gmail compose or reminder creation. Edits survive refresh. Speech uses the chosen language and at most 240 characters; long summaries use complete sentences or a short saved-minutes message. Gmail opens a compose window for review, never sends mail automatically.

Each task shows its extracted deadline. No deadline is guessed. **Create reminder** requires a title and a separately confirmed future date/time in the displayed browser timezone. Missing or ambiguous wording stays unresolved until then. The reminder and task link save atomically. Rapid clicks, retries, reopening and refresh reuse the same reminder. Editing a linked task keeps the link and leaves the reminder unchanged; open the reminder to edit its title or schedule. Removing a task does not delete its reminder.

API failures keep the input. Save retries reuse the validated response and original turn ID. Minutes requests hold the existing busy/session lock, and storage checks the original conversation before committing. The minutes fixture definitions are authored but have not been executed. No browser or provider verification is claimed.

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

Tests, manual browser QA, smoke checks, provider probes and CI execution require the user's explicit confirmation for each run. The Node fixture cases in `tests/` cover transcript finalization, draft-only and combined commands, contact selection, version-1 upgrades, atomic rollback, concurrent saves, replay after editing, contact persistence and physical Right Ctrl hold/release handling. They ran in CI through commit `ad81331` (`41742148454`). `fake-indexeddb` is a test-only dependency for isolated in-memory storage cases; it is not included in the application bundle. No automatic test workflow is added. Any proposed browser or provider run must identify its cases, revision and live provider use before approval.

Shared UI components live in `src/components/ui/`. They come from the [official shadcn/ui New York registry](https://ui.shadcn.com/docs/components/radix/button), with Morning's styles and motion choices. Their MIT notice is included in that directory. Fonts are served locally from the installed package.
## Read-only voice lookups

The existing mic accepts hotels, weather, news, general factual questions and city-time requests. The command parser treats a lookup as a read-only result and rejects mixed lookup/action responses. Search terms and location go through the server; guests provide no MCP client or provider key.

The browser saves a lookup's answer, sources and lookup time together on its conversation turn before speaking. Each lookup has a compact result row that opens the existing Quick View. Source links open in a new tab, and publication time, weather data time and lookup time have separate labels. Queries without a location ask for one; recording the reply continues the same lookup. Cancel search clears that pending question.

History and Play reply read the saved snapshot. A persistence retry uses its cached command response, while an explicit retry after a provider failure can retrieve fresh information. Switching sessions during retrieval keeps the result in its original conversation. Lookup rate limits disable lookup retries while leaving the mic available for other commands.

The integration fixtures are defined in `tests/lookup-flow.test.ts` and `tests/lookup-result.test.ts`. No tests, browser QA or live-provider probes were executed for this change. The manual lookup workflow requires explicit approval at the commit to be checked.
