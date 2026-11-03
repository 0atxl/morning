# Morning Go API

The browser streams microphone audio directly to Deepgram, then sends the complete final transcript to Go once. A command can create a reminder, prepare an editable email draft, do both together, or move an existing reminder. When Morning needs more information it returns a question and zero actions.

The browser commits actions to IndexedDB using `command_id` to prevent duplicate saves. After a new save, it can request a short spoken confirmation from the optional speech endpoint. The existing browser voice provides a fallback. Drafts stay editable and unsent.

A calendar command returns one event for a client to preview and export. The shipped dashboard currently consumes reminder creation and email-draft actions only. Reminder corrections, calendar `.ics` download, meeting minutes and ElevenLabs playback still need browser integration. The endpoint examples below describe the backend contracts.

## Local startup

Use Go 1.22 or newer. The server uses the standard library and embeds IANA timezone data. It needs no external Go modules or `go.sum`.

From the repository root:

```bash
cd server
[ -e .env ] || cp .env.example .env
# Fill in the required keys in .env. Add both ElevenLabs settings to enable speech.
set -a
. ./.env
set +a
go run -buildvcs=false .
```

The default address is `127.0.0.1:8080`. The shell loads `server/.env` before Go starts. Restart the process with the updated environment after changing a value. `-buildvcs=false` also permits startup from a source snapshot without usable Git metadata. Keep `.env` out of Git.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DEEPGRAM_API_KEY` | Yes | Permanent server-side Deepgram key with Member or higher permission to grant temporary tokens. |
| `GROQ_API_KEY` | Yes | Server-side Groq key for `openai/gpt-oss-20b`. |
| `ELEVENLABS_API_KEY` | No | Server-side ElevenLabs key with text-to-speech access. |
| `ELEVENLABS_VOICE_ID` | No | ID of an ElevenLabs voice available to that key. |
| `LISTEN_ADDR` | No | Go listen address. Set `0.0.0.0:8080` when the hosting environment requires it. |

On the Azure VM, use `sudoedit /etc/morning/server.env` to set both ElevenLabs variables and `sudo systemctl restart morning-api.service` to load them. Use the Go service environment for these values. The frontend build needs neither. Startup and command interpretation work with either ElevenLabs setting blank.

For a free ElevenLabs account, choose a premade voice available to that account. Shared Voice Library voices can appear in the account's list but require a paid plan for API use. Morning reports `speech_plan_required` when ElevenLabs rejects synthesis for this reason. [ElevenLabs voice types](https://elevenlabs.io/docs/overview/capabilities/voices)

The included Vite development server proxies `/api` to `http://127.0.0.1:8080`. Production must serve the browser and `/api` on the same HTTPS origin. Go serves only the API, so the hosting layer serves the compiled web assets. No CORS configuration is needed for this arrangement.

## Temporary voice token

`POST /api/voice/token`, with `Content-Type: application/json`:

```json
{}
```

`200 OK`:

```json
{
  "access_token": "<temporary Deepgram JWT>",
  "expires_in": 30,
  "websocket_url": "wss://api.deepgram.com/v1/listen?model=nova-3&language=en-US&interim_results=true&smart_format=true"
}
```

After mic permission is granted and audio capture is ready, request a token and connect immediately:

```js
const socket = new WebSocket(result.websocket_url, ["bearer", result.access_token]);
```

Use the `bearer` subprotocol for the temporary JWT. Never send the permanent server key to the browser or put a token in a URL. [Deepgram's browser transport uses this authentication scheme](https://github.com/deepgram/deepgram-js-sdk/blob/v4.9.1/src/packages/AbstractLiveClient.ts).

The server requests a 30-second grant from `POST https://api.deepgram.com/v1/auth/grant`. The token needs to be valid when the connection opens. An established WebSocket can stay open after expiry. The grant permits Deepgram voice APIs and is not restricted to Nova-3, so the browser must use the returned Nova-3 URL. See [Deepgram token authentication](https://developers.deepgram.com/guides/fundamentals/token-based-authentication) and the [grant reference](https://developers.deepgram.com/reference/auth/tokens/grant).

If Deepgram omits `expires_in`, the browser response uses the requested 30-second TTL. Explicit invalid expiry values, empty tokens and returned permanent keys fail validation.

The URL assumes containerized audio such as MediaRecorder WebM/Opus. A browser sending raw PCM must supply its actual `encoding`, `sample_rate` and `channels` in the WebSocket URL. Interim captions can change. On Stop, flush pending audio and wait for Deepgram's final results before posting the transcript. Combine final segments in order without treating interim revisions as new commands.

Token issuance allows 30 requests per client IP and 300 total requests per server process per UTC minute. Commands allow 60 per IP and 600 total per minute. Speech allows 60 per IP and 600 total per minute. Attempts count even if a provider fails. `429` responses include a `Retry-After` header in seconds. Limits reset at minute boundaries and process restart. They are not shared between server instances. Provider account quotas are separate and are not changed by these application limits. An upstream HTTP 429 returns a distinct `voice_provider_rate_limited`, `command_provider_rate_limited` or `minutes_provider_rate_limited` error with a retry delay.

For a loopback TCP peer, the limiter uses a valid `CF-Connecting-IP` supplied by Cloudflare Tunnel through nginx. The production origin must remain loopback-only. Direct non-loopback requests use their peer IP, and `X-Forwarded-For` is always ignored. This gives public visitors separate allowances while preserving the global cap. Visitors sharing one public IP still share that IP's allowance. A different ingress must sanitize its client identity before using this setup.

## Interpret a command

`POST /api/commands`, with `Content-Type: application/json`:

```json
{
  "command_id": "5db11242-ecba-4acf-876a-f92c4fae4b86",
  "transcript": "Remind me in ten minutes to check the oven",
  "now": "2026-11-03T09:00:00+05:30",
  "timezone": "Asia/Kolkata"
}
```

Generate a command ID once per completed recording. `crypto.randomUUID()` is suitable. `now` is an RFC 3339 timestamp representing the current instant; JavaScript's UTC `toISOString()` is also accepted. `timezone` is an IANA name, such as `Intl.DateTimeFormat().resolvedOptions().timeZone`. Go converts `now` to that timezone before sending context to Groq.

`200 OK` for the reminder above:

```json
{
  "command_id": "5db11242-ecba-4acf-876a-f92c4fae4b86",
  "actions": [
    {
      "type": "create_reminder",
      "title": "Check the oven",
      "due_at": "2026-11-03T09:10:00+05:30"
    }
  ],
  "clarification": null
}
```

For `"Remind me to check the oven"`, `200 OK` instead returns:

```json
{
  "command_id": "5db11242-ecba-4acf-876a-f92c4fae4b86",
  "actions": [],
  "clarification": "When should I remind you to check the oven?"
}
```

Display the question without saving a reminder. A missing or ambiguous time requires a complete revised command with a new ID and timestamp. The backend stores no conversation state.

### Email draft and reminder

Send relevant contacts from this browser's address book in the optional `contacts` array. Omitted contacts mean an empty list. No account is required.

```json
{
  "command_id": "draft-follow-up-1",
  "transcript": "Draft Priya an email asking her to confirm the revised timeline, and remind me Friday at ten AM to follow up.",
  "now": "2026-11-03T09:00:00+05:30",
  "timezone": "Asia/Kolkata",
  "contacts": [
    {"id": "priya-shah", "name": "Priya Shah", "email": "priya.shah@example.com"}
  ]
}
```

`200 OK`:

```json
{
  "command_id": "draft-follow-up-1",
  "actions": [
    {
      "type": "draft_email",
      "to_contact_id": "priya-shah",
      "subject": "Confirm the revised timeline",
      "body": "Hi Priya,\n\nCould you confirm the revised timeline?\n\nThanks!"
    },
    {
      "type": "create_reminder",
      "title": "Follow up with Priya",
      "due_at": "2026-11-06T10:00:00+05:30"
    }
  ],
  "clarification": null
}
```

For a draft alone, use a new command ID and the transcript `"Draft Priya an email asking her to confirm the revised timeline."` with the same contact context. The response contains only the draft:

```json
{
  "command_id": "draft-only-1",
  "actions": [
    {
      "type": "draft_email",
      "to_contact_id": "priya-shah",
      "subject": "Confirm the revised timeline",
      "body": "Hi Priya,\n\nCould you confirm the revised timeline?\n\nThanks!"
    }
  ],
  "clarification": null
}
```

The browser resolves `to_contact_id` against the supplied contact snapshot and stores the draft for editing. Subject and body are plain text. No message is sent. A command can contain at most one draft and one reminder; Go validates the complete result before returning actions.

### Contact clarification

If both Priya Shah and Priya Rao are supplied for the compound example, `200 OK` returns choices and zero actions, even if the model picked one:

```json
{
  "command_id": "draft-follow-up-1",
  "actions": [],
  "clarification": "Which Priya should I draft the email to?",
  "clarification_options": [
    {"contact_id": "priya-shah", "name": "Priya Shah", "email": "priya.shah@example.com"},
    {"contact_id": "priya-rao", "name": "Priya Rao", "email": "priya.rao@example.com"}
  ]
}
```

Go matches complete name words, ignoring case and punctuation. `Priya` matches both names; `Priya Rao` narrows the choice. Offered names and addresses come from the request snapshot. A selection must belong to those matching contacts. Duplicate contact IDs or an invalid selection return the existing `400 invalid_request` envelope.

Save neither action while waiting for a selection. Retain the pending request and resend it with the same ID, transcript, timestamp, timezone and contacts, adding `"selected_contact_id": "priya-rao"`. The successful response binds the draft to that ID and resolves Friday from the original timestamp. If the provider returns a draft for a different ID, Go rejects the response. `clarification_options` appears only when a contact choice is needed; the existing reminder-only response stays unchanged.

A missing contact also returns zero actions and a question. Add the contact locally and submit a complete revised request with a new command ID. A missing or ambiguous reminder time blocks the draft as well, until a complete revised command resolves it.

### Correct a saved reminder

Suppose the guest said "Draft Priya an email asking for the slides, and remind me Friday at ten AM to follow up." The browser saved both results under the first command receipt, and the guest edited the draft. For the next recording, send a fresh command ID and the saved reminder's ID and due time. Omit `reminder_context` if the browser cannot identify one relevant saved reminder.

```json
{
  "command_id": "correction-2",
  "transcript": "Actually, make that eleven.",
  "now": "2026-11-03T09:02:00+05:30",
  "timezone": "Asia/Kolkata",
  "reminder_context": {
    "id": "draft-follow-up-1",
    "due_at": "2026-11-06T10:00:00+05:30"
  }
}
```

The saved `due_at` is an RFC 3339 instant. Go interprets it in the request's IANA timezone. In this example the saved time supplies both Friday and AM. HTTP 200 returns one update.

```json
{
  "command_id": "correction-2",
  "actions": [
    {
      "type": "reschedule_reminder",
      "reminder_id": "draft-follow-up-1",
      "due_at": "2026-11-06T11:00:00+05:30"
    }
  ],
  "clarification": null
}
```

The record ID comes from the browser's snapshot. Groq receives the saved time and supplies the replacement time. The dashboard supplies the sole reminder in the recording's conversation. If several reminders could be the target, it displays a choice and resubmits the original ID, transcript, timestamp and chosen snapshot. `selected_reminder_id` must match `reminder_context.id`; it records an explicit user selection. Relative durations are anchored to the original request's `now`. With no clear target, the correction returns HTTP 200.

```json
{"command_id":"correction-2","actions":[],"clarification":"Which reminder should I move?"}
```

An unclear time also returns an empty array and one question. Save a correction in one IndexedDB transaction over reminders and command receipts. First check the correction's receipt. On a replay, use its saved reminder ID. On a new correction, read the existing reminder by `reminder_id`, update only its due time, and add the receipt. If the record is missing or its due time has changed since the supplied snapshot, abort and refresh the context. An HTTP retry reuses the full request, including its ID and snapshot. Update the visible row and speak the new time after a successful new commit. The draft can keep its edited subject and body throughout.

### Calendar event for download

Send the usual command request to `POST /api/commands`.

```json
{
  "command_id": "review-1",
  "transcript": "Schedule a project review Friday at three PM for thirty minutes.",
  "now": "2026-11-03T09:00:00+05:30",
  "timezone": "Asia/Kolkata"
}
```

Example `200 OK` response

```json
{
  "command_id": "review-1",
  "actions": [{
    "type": "create_calendar_event",
    "title": "Project review",
    "start": "2026-11-06T15:00:00+05:30",
    "end": "2026-11-06T15:30:00+05:30",
    "timezone": "Asia/Kolkata"
  }],
  "clarification": null
}
```

An event is a standalone action. Both timestamps have second precision and explicit offsets. Display them in the returned IANA timezone. Go checks that the start is in the future and the end follows it. A spoken duration advances the start by elapsed time, including across a daylight-saving transition.

If the speaker omits the duration or finish time, a clarification can return HTTP 200 with this body.

```json
{"command_id":"review-1","actions":[],"clarification":"How long should the project review last?"}
```

A missing date or ambiguous start time also requires a question. Offer the download only for a completed event. "Remind me in ten minutes to schedule a meeting" uses the existing reminder action.

For a local `.ics` file, write one `VEVENT` in a `VCALENDAR` with `VERSION:2.0` and a `PRODID`. Use the escaped title as `SUMMARY`, a stable `UID` derived from the command ID, and a UTC `DTSTAMP`. For this example the UTC event times are `DTSTART:20261106T093000Z` and `DTEND:20261106T100000Z`. Use CRLF line endings and fold long lines at 75 octets. A second download can reuse the saved event without calling Groq. [iCalendar file format](https://www.rfc-editor.org/rfc/rfc5545)

### Saving and retries

For create and draft actions, keep the original request on an explicit HTTP retry. The server stores no command history and can call Groq again. The browser must use one IndexedDB read/write transaction spanning reminders, drafts and command receipts. Check the unique receipt by `command_id`; if present, reuse its saved records and ignore the replay. Otherwise, create every returned record and add the receipt in that same transaction. One reminder and one draft can use the same ID in their separate stores.

If any write fails, abort all writes, including the receipt. Retrying after an abort can save the whole result. Retrying after a commit must preserve both records and any later draft edits. Account for existing reminder records when introducing command receipts. Speak only after the new transaction completes, and never announce another success on a replay. An error response contains no actions.

Go uses Groq's [strict JSON schema mode](https://console.groq.com/docs/structured-outputs) for `openai/gpt-oss-20b`. It checks action counts and fields, contact membership, text limits, future reminder timestamps and IANA offsets. UTC output uses `+00:00`. Unsupported actions, duplicate action types, mixed draft/reminder fields, refusals, truncated output and tool calls are rejected. Transcript and contact context are data in a separate user message. There are no tools or server-side action execution.

Groq interprets natural language and computes the requested due time. Go validates the structure and time constraints; it does not independently parse every spoken time expression. A fixture response establishes the intended contract, not live model accuracy.

## Spoken confirmation

After IndexedDB commits a new action, compose one short line from the saved action type and its saved due time, if any. Send only that line. Keep transcripts, reminder titles, draft content and meeting minutes out of synthesis requests.

```http
POST /api/speech HTTP/1.1
Content-Type: application/json

{"text":"Draft saved. I’ll remind you Friday at ten."}
```

On success, the response is `200 OK` with `Content-Type: audio/mpeg` and `Cache-Control: no-store`. The body contains raw MP3 bytes. Read it with `response.blob()` for playback. Go requests `mp3_44100_128` using Flash v2.5 (`eleven_flash_v2_5`). [ElevenLabs speech API](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)

An ElevenLabs outage returns `502 Bad Gateway` with `Content-Type: application/json`.

```json
{"error":{"code":"speech_provider_unavailable","message":"Morning couldn't generate the spoken confirmation.","retryable":true}}
```

If either setting is missing, the endpoint returns `503 speech_not_configured`. A provider timeout returns `504 speech_provider_timeout` after eight seconds. Empty, oversized or unrecognized audio returns `502 speech_provider_invalid_response`.

**Dashboard integration.** In the post-commit speech helper, try the MP3 first and use the existing browser voice if the request or playback fails. A replayed command stays silent. **Retry speech** uses the saved confirmation alone. It must never submit a command or write to IndexedDB.

Send one JSON object with only `text`, a single line of 1 to 240 Unicode characters without surrounding whitespace. The request body is limited to 2 KiB and returned audio to 1 MiB. Speech has its own allowance of 60 requests per client IP and 600 per server process per UTC minute.

## Meeting minutes

After a meeting ends, send the completed transcript in order to `POST /api/minutes` with `Content-Type: application/json`. The entire request body can contain up to 64 KiB. The endpoint uses the existing Groq key and shares the command endpoint's rate limit. Requests spoken during the meeting are discussion. The endpoint returns editable text and performs no reminder, draft or email operations.

```json
{"transcript":"We’ll ship Friday. Priya will send the slides. We haven’t decided who runs QA."}
```

Example `200 OK` response

```json
{
  "summary": "The team will ship Friday. Priya will send the slides. QA ownership is open.",
  "decisions": ["Ship Friday."],
  "action_items": [
    {"task": "Send the slides.", "owner": "Priya", "deadline": null}
  ],
  "open_questions": ["Who will run QA?"]
}
```

All four fields are present. Empty sections are `[]`. Each task has a plain-text description, a nullable owner and a nullable deadline. A stated deadline keeps the speaker's wording. Quick View can edit these fields and use the edited values for a local `.txt` export. Retain the transcript if the request fails.

A blank transcript returns `400 Bad Request`.

```json
{"error":{"code":"invalid_request","message":"Provide the completed meeting transcript.","retryable":false}}
```

A Groq outage returns `502 Bad Gateway`.

```json
{"error":{"code":"minutes_provider_unavailable","message":"Morning couldn't prepare the meeting minutes. Please try again.","retryable":true}}
```

The same error object carries `413 request_too_large` for an oversized request, `502 minutes_provider_invalid_response` for incomplete or invalid minutes, and `504 minutes_provider_timeout` for a provider timeout. The two provider errors are retryable.

## Errors and limits

A Groq outage returns `502 Bad Gateway`:

```json
{
  "command_id": "5db11242-ecba-4acf-876a-f92c4fae4b86",
  "error": {
    "code": "command_provider_unavailable",
    "message": "Morning couldn't interpret your command. Please try again.",
    "retryable": true
  }
}
```

Show `error.message` and retain the transcript. Command errors include `command_id` when Go parsed a valid ID. All endpoints return `Cache-Control: no-store`. Go keeps provider bodies, keys and transcripts out of logs.

| HTTP status | Error code | Meaning |
| --- | --- | --- |
| `400` | `invalid_request` | Malformed JSON, unknown fields or invalid command context. |
| `404` | `not_found` | Endpoint is outside this milestone. |
| `405` | `method_not_allowed` | Use POST. |
| `413` | `request_too_large` | Token body exceeds 1 KiB, speech body exceeds 2 KiB, command body exceeds 64 KiB or minutes body exceeds 64 KiB. |
| `415` | `unsupported_media_type` | Send `application/json`. |
| `429` | `rate_limited` | Wait for `Retry-After` before retrying. |
| `429` | `voice_provider_rate_limited`, `command_provider_rate_limited`, `minutes_provider_rate_limited` | The provider, rather than Morning's application limiter, returned HTTP 429. Wait for the retry delay. |
| `502` | `voice_provider_unavailable`, `command_provider_unavailable` | Provider request failed. |
| `502` | `voice_provider_invalid_response`, `command_provider_invalid_response` | Provider output failed validation. |
| `504` | `voice_provider_timeout`, `command_provider_timeout` | Provider exceeded the 20-second HTTP timeout. |

Command and contact IDs allow 1 to 128 ASCII letters, digits, hyphens or underscores. Transcripts allow up to 8192 UTF-8 bytes. Supply at most 20 relevant contacts, each with a name up to 200 characters and a plain email address up to 254 characters. Reminder titles and draft subjects allow up to 200 characters. Draft bodies allow up to 8000 characters and can include line breaks. The whole command body allows 64 KiB to accommodate a saved draft snapshot. Groq may return up to 4096 completion tokens. There is no automatic provider retry. Keys must stay in the server environment, without `VITE_` prefixes.

## Conversational replies and draft revisions

Greetings and capability questions go to Groq through the same interpretation request. The model returns a standalone `reply` action with at most 240 characters. Go validates it and returns `actions: []`, `clarification: null` and `reply: "..."` to the dashboard. No reminder or draft is created. The browser saves the reply on its conversation turn before attempting speech. Replies cannot accompany saved actions. The language is model-generated; application validation and idempotency remain deterministic.

For a spoken draft edit, include `draft_context` with the saved `id`, `subject`, `body`, `recipient` and `to`. The model receives those fields without the record ID and returns `update_draft` with the complete revised `subject` and `body`. Go assigns `draft_id` from the supplied snapshot. If a user picked among drafts, `selected_draft_id` must match that snapshot. A missing draft asks which one to update. The browser atomically checks the receipt, conversation, saved subject, body and recipient before updating the original record. A concurrent manual edit aborts a stale update. Replaying an applied request preserves later changes and creates no new draft. Voice edits preserve the recipient; Quick View can edit that field by hand.

The drafting prompt asks for a developed email, usually 60 to 120 words unless the user asks for brevity, with a clear request, relevant supplied detail and a natural close. It prohibits invented dates, reasons, promises and sender names. These are generation instructions; model quality still needs a live review.

## Verification

Tests require explicit user confirmation for each run and run only on GitHub Actions. The manually dispatched [Fixture tests workflow](../.github/workflows/backend-tests.yml) runs Go provider fixtures and isolated Node browser-logic fixtures for an approved revision. It has no automatic triggers and needs no provider credentials. It covers contracts, storage, retries, speech stubs and calendar serialization without opening a browser or contacting a live provider. Do not run the suite locally or dispatch it without approval for that exact revision and scope.

The custom test transport returns local `testdata/` fixtures and cannot reach live providers. Cases cover a draft alone, the Friday compound command, contact ambiguity despite a confident model choice, valid and invalid selections, all-or-nothing output validation, the original reminder response, missing context, provider failures, timezones and token grants. The new draft cases have been authored but have not run. No provider probes, browser QA or CI were run for this change.

Smoke and browser E2E verification require a separately approved, manually dispatched GitHub Actions run with the cases, commit and live-provider usage stated. Backend fixture tests do not verify microphone capture, IndexedDB transactions, duplicate saves after an edit, or browser speech.

The correction fixture cases cover the Friday time change, replay of the same request, missing context, vague times, invalid provider actions and malformed reminder snapshots. The backend stops at the validated response.
