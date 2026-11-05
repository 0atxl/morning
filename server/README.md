# Morning Go API

The browser streams microphone audio directly to Deepgram, then sends the complete final transcript to Go once. A command can create a reminder, prepare an editable email draft, do both together, or move an existing reminder. When Morning needs more information it returns a question and zero actions.

The browser commits actions to IndexedDB using `command_id` to prevent duplicate saves. After a new save, it can request a short spoken confirmation from the optional speech endpoint. The existing browser voice provides a fallback. Drafts stay editable and unsent.

A calendar command returns validated event data. The dashboard saves only its start as a reminder and exports a one-minute calendar marker. It does not retain the event end, schedule a full-duration event or sync calendar changes. The endpoint examples below describe the backend contracts.

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
| `TAVILY_API_KEY` | No | Server-side Tavily key for read-only hotel, news and web lookups via Tavily MCP. |
| `ELEVENLABS_API_KEY` | No | Server-side ElevenLabs key with text-to-speech access. |
| `ELEVENLABS_VOICE_ID` | No | ID of an ElevenLabs voice available to that key. |
| `MORNING_GMAIL_ADDRESS` | No | Gmail address for owner-paired automatic reminder emails. |
| `MORNING_GMAIL_APP_PASSWORD` | No | 16-character Gmail app password for SMTP delivery. |
| `TELEGRAM_BOT_TOKEN` | No | Telegram Bot Token for instant mobile push notifications when reminders are due. |
| `TELEGRAM_CHAT_ID` | No | Telegram Chat ID to receive reminder alert messages. |
| `LANGSMITH_API_KEY` | No | LangSmith API key for asynchronous command tracing, latency monitoring, and LLM evaluation. |
| `LANGSMITH_PROJECT` | No | LangSmith project name (defaults to `morning`). |
| `MORNING_REMINDER_OWNER_KEY` | No | Secret owner key (at least 32 characters) required to schedule reminder emails. |
| `MORNING_REMINDER_STATE_DIR` | No | Directory for persisted reminder email schedules (defaults to `/var/lib/morning/reminder-email`). |
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
  "websocket_url": "wss://api.deepgram.com/v1/listen?model=nova-3&language=multi&language_hint=en&language_hint=hi&interim_results=true&smart_format=true"
}
```

After mic permission is granted and audio capture is ready, request a token and connect immediately:

```js
const socket = new WebSocket(result.websocket_url, ["bearer", result.access_token]);
```

[Nova-3 multilingual mode](https://developers.deepgram.com/docs/nova-3-language-prompting) accepts English, Hindi and mixed speech on this connection. Hints bias recognition toward English and Hindi. No additional key or language selector is needed. Each new command defaults to English. Go selects Hindi when the command contains Devanagari or recognized Romanized Hindi command wording, ignoring quoted content, and tells Groq which response language to use. An unsupported Hindi flag from the model cannot switch an English action confirmation. Go emits optional `reply_language: "hi"` for Hindi/Hinglish responses; omission means English. Names such as Priya and Pune do not select Hindi. Pending `lookup_context` retains the original question's language, so a city-name reply finishes that lookup in the same language.

The browser saves the reply language with a lookup snapshot for History and Play reply. Weather and time use Hindi templates. Search evidence keeps original titles, quotes and links; the existing evidence-selection call can translate its supported answer into Hindi without another tool call. Contact matching remains exact across scripts rather than guessing transliterations.

A spoken reply to a location question may be a place name or a full question. A separate, constrained Groq extraction returns only a normalized place string or null; it cannot create actions or change the pending lookup kind. Go keeps the original lookup and reply language, validates the place, then retrieves facts. Extraction has an eight-second timeout and its own limit of four replies per visitor and 40 across the service per minute. A reply without a usable location asks again without calling search or weather. This also lets a full Hindi question replace previously saved question text in a failed lookup's place field.

Use the `bearer` subprotocol for the temporary JWT. Never send the permanent server key to the browser or put a token in a URL. [Deepgram's browser transport uses this authentication scheme](https://github.com/deepgram/deepgram-js-sdk/blob/v4.9.1/src/packages/AbstractLiveClient.ts).

The server requests a 30-second grant from `POST https://api.deepgram.com/v1/auth/grant`. The token needs to be valid when the connection opens. An established WebSocket can stay open after expiry. The grant permits Deepgram voice APIs and is not restricted to Nova-3, so the browser must use the returned Nova-3 URL. See [Deepgram token authentication](https://developers.deepgram.com/guides/fundamentals/token-based-authentication) and the [grant reference](https://developers.deepgram.com/reference/auth/tokens/grant).

If Deepgram omits `expires_in`, the browser response uses the requested 30-second TTL. Explicit invalid expiry values, empty tokens and returned permanent keys fail validation.

The URL assumes containerized audio such as MediaRecorder WebM/Opus. A browser sending raw PCM must supply its actual `encoding`, `sample_rate` and `channels` in the WebSocket URL. Interim captions can change. On Stop, flush pending audio and wait for Deepgram's final results before posting the transcript. Combine final segments in order without treating interim revisions as new commands.

Token issuance allows 30 requests per client IP and 300 total requests per server process per UTC minute. Commands allow 60 per IP and 600 total per minute. Speech allows 60 per IP and 600 total per minute. Attempts count even if a provider fails. `429` responses include a `Retry-After` header in seconds. Limits reset at minute boundaries and process restart. They are not shared between server instances. Provider account quotas are separate and are not changed by these application limits. An upstream HTTP 429 returns a distinct `voice_provider_rate_limited`, `command_provider_rate_limited` or `minutes_provider_rate_limited` error with a retry delay.

For a loopback TCP peer, the limiter uses a valid `CF-Connecting-IP` supplied by Cloudflare Tunnel through nginx. The production origin must remain loopback-only. Direct non-loopback requests use their peer IP. Both `X-Forwarded-For` and `X-Real-IP` are ignored. This gives public visitors separate allowances while preserving the global cap. Visitors sharing one public IP still share that IP's allowance. A different ingress must sanitize its client identity before using this setup.

Groq quotas are separate and shared across the provider organization. `command_provider_rate_limited` identifies a Groq refusal, while `rate_limited` identifies Morning's own public limit. A provider 429 never triggers generation repair or an automatic provider retry. Go forwards a valid provider `Retry-After` as whole seconds, rounding fractional values up and accepting HTTP dates. Missing/invalid timing uses a 60-second fallback, not a guarantee that the account quota resets then. Provider response bodies and raw headers stay out of errors and logs. The browser retains the transcript and uses the returned wait before retry. Check the account's [Groq limits](https://console.groq.com/docs/rate-limits) to distinguish request/token minute and daily limits.

## Interpret a command

Optional `previous_turn` contains only `transcript`, `topic`, `answer` and `reply`, each an optional string. Their limits are respectively 8192, 300, 4000 and 1000 UTF-8 bytes. The browser selects the most recent answered lookup, minutes or conversational reply in the active session, skips pending questions and action-only turns, and truncates on UTF-8 boundaries. A lookup's topic is its saved `query` string. This context is untrusted historical data, never permission to repeat an action. Writes still use the current transcript, explicit saved-item contexts and the existing command receipt. Pending place replies omit `previous_turn`, contacts and action contexts.

Reminder actions may include `repeat: "daily"`, `"weekly"` or `"weekdays"`. The model schema requires `repeat`, using `""` for a one-off or ordinary reschedule. Go also accepts its omission from older provider fixtures. Empty values are omitted from the public action and from a new saved reminder. An ordinary reschedule preserves existing recurrence. Clearing recurrence and correct occurrence advancement remain pending lifecycle work.

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

### Calendar data and reminder markers

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

The event payload is a standalone action. Both timestamps have second precision and explicit offsets. Go checks that the start is in the future and the end follows it. A spoken duration advances the start by elapsed time, including across a daylight-saving transition. The dashboard converts this payload to `create_reminder` at `start`, discards `end` and saves no full-duration calendar event.

If the speaker omits the duration or finish time, a clarification can return HTTP 200 with this body.

```json
{"command_id":"review-1","actions":[],"clarification":"How long should the project review last?"}
```

A missing date or ambiguous start time also requires a question. Offer the reminder's calendar-marker download only after the reminder is saved. "Remind me in ten minutes to schedule a meeting" uses the existing reminder action.

The existing reminder serializer writes one `VEVENT` in a `VCALENDAR`, with an escaped title, stable UID, UTC timestamps, CRLF line endings and folded lines. For this example the dashboard's one-minute marker is `DTSTART:20261106T093000Z` to `DTEND:20261106T093100Z`, regardless of the API's validated end. A second download uses the saved reminder without calling Groq. Calendar copies do not sync with Morning edits. [iCalendar file format](https://www.rfc-editor.org/rfc/rfc5545)

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

Send one JSON object with `text`, a single line of 1 to 240 Unicode characters without surrounding whitespace, and optional `language` (`en` or `hi`). Hindi requests include `language_code: "hi"` in the existing Flash v2.5 call. Browser fallback sets `hi-IN` and prefers an installed Hindi voice. It cannot install voices. The request body is limited to 2 KiB and returned audio to 1 MiB. Speech has its own allowance of 60 requests per client IP and 600 per server process per UTC minute.

## Meeting minutes

Send pasted meeting notes or a completed spoken transcript in order to `POST /api/minutes` with `Content-Type: application/json`. This endpoint does not record a live or remote meeting. The entire JSON request body can contain up to 64 KiB. The endpoint uses the existing Groq key and shares the command endpoint's rate limit. Embedded reminder, email and language-change instructions are discussion, not commands. The endpoint returns editable text, calls no tools and performs no reminder, draft, email or storage writes.

```json
{"transcript":"We’ll ship Friday. Priya will send the slides. We haven’t decided who runs QA.","language":"en"}
```

`language` is optional and accepts only `"en"` or `"hi"`. Omitting it selects English, regardless of the transcript's language or embedded instructions. Explicit `null`, empty strings, unsupported values and nonstrings return `400 invalid_request`. The selected language applies to the summary, decisions, action-item tasks and open questions. Owners, deadlines and provider-only supporting quotes retain the transcript's wording without translation.

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

The response contains exactly these four fields. Empty sections are `[]`, never null. Each of `decisions`, `action_items` and `open_questions` contains at most 20 entries. Each action item has `task`, `owner` and `deadline`; owner and deadline are required keys with a string or null value. The backend rejects missing keys and unknown fields in provider output rather than relying on the provider schema alone. Owners and deadlines must be quoted from that task's verbatim supporting clause; missing values remain null.

All returned text fields are single-line. The backend limits summary to 800 Unicode characters, decisions/questions/tasks to 500 each and owner/deadline to 200 each. Provider-only `source` quotes are validated and removed before returning the response. This endpoint returns minutes directly, without a command action, clarification envelope or receipt. The browser must validate the response, store edited minutes locally and keep a stable turn receipt. For a local save retry, reuse the validated response rather than requesting new minutes. Retain the transcript if the API request fails.

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

Show `error.message` and retain the transcript. Command errors include `command_id` when Go parsed a valid ID. All endpoints return `Cache-Control: no-store`. Go logs fixed validation stages and reasons, without provider bodies, keys, contact values or transcripts.

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
| `422` | `command_provider_invalid_response` | Generated command failed validation after one correction attempt. Rephrase or retry; no actions were returned. |
| `502` | `voice_provider_invalid_response` | Voice token response failed validation. |
| `504` | `voice_provider_timeout`, `command_provider_timeout` | Provider exceeded the 20-second HTTP timeout. |

Command and contact IDs allow 1 to 128 ASCII letters, digits, hyphens or underscores. Transcripts allow up to 8192 UTF-8 bytes. Supply at most 20 relevant contacts, each with a name up to 200 characters and a plain email address up to 254 characters. Reminder titles and draft subjects allow up to 200 characters. Draft bodies allow up to 8000 characters and can include line breaks. The whole command body allows 64 KiB to accommodate a saved draft snapshot. Groq may return up to 4096 completion tokens. Keys must stay in the server environment, without `VITE_` prefixes.

When a generated command fails validation, Go makes at most one correction attempt using the original request and a fixed validation reason. Both attempts and any subsequent lookup share the command's 22-second deadline. Lookup work has a 16-second subdeadline, bounded by the command time remaining. Place extraction and candidate selection each have an eight-second subdeadline. The command-provider HTTP client permits at most 20 seconds per call; the lookup HTTP client permits at most 16 seconds. nginx permits 30 seconds of upstream read inactivity; the browser JSON deadline is 30 seconds and Go's response write timeout is 35 seconds. These limits are not additive. The corrected result must pass the same validation before any lookup or proposed browser save. Rate limits, outages and timeouts do not trigger an automatic retry. A persistent command validation failure returns JSON with HTTP 422 so a proxy's gateway error page cannot replace the explanation. Voice, speech and minutes behavior is unchanged.

## Conversational replies and draft revisions

Greetings and capability questions go to Groq through the same interpretation request. The model returns a standalone `reply` action with at most 240 characters. Go validates it and returns `actions: []`, `clarification: null` and `reply: "..."` to the dashboard. No reminder or draft is created. The browser saves the reply on its conversation turn before attempting speech. Replies cannot accompany saved actions. The language is model-generated; application validation and idempotency remain deterministic.

For a spoken draft edit, include `draft_context` with the saved `id`, `subject`, `body`, `recipient` and `to`. The model receives those fields without the record ID and returns `update_draft` with the complete revised `subject` and `body`. Go assigns `draft_id` from the supplied snapshot. If a user picked among drafts, `selected_draft_id` must match that snapshot. A missing draft asks which one to update. The browser atomically checks the receipt, conversation, saved subject, body and recipient before updating the original record. A concurrent manual edit aborts a stale update. Replaying an applied request preserves later changes and creates no new draft. Voice edits preserve the recipient; Quick View can edit that field by hand.

The drafting prompt asks for a developed email, usually 60 to 120 words unless the user asks for brevity, with a clear request, relevant supplied detail and a natural close. It prohibits invented dates, reasons, promises and sender names. These are generation instructions; model quality still needs a live review.

## Verification

Tests require explicit user confirmation for each run and run only on GitHub Actions. The manually dispatched [Fixture tests workflow](../.github/workflows/backend-tests.yml) runs Go provider fixtures and isolated Node browser-logic fixtures for an approved revision. It has no automatic triggers and needs no provider credentials. It covers contracts, storage, retries, speech stubs and calendar serialization without opening a browser or contacting a live provider. Do not run the suite locally or dispatch it without approval for that exact revision and scope.

The custom test transport returns local `testdata/` fixtures and cannot reach live providers. Cases cover a draft alone, the Friday compound command, contact ambiguity despite a confident model choice, valid and invalid selections, all-or-nothing output validation, the original reminder response, missing context, provider failures, timezones and token grants. The fixture workflow has run in CI through commit `ad81331` (`41742148454`).

Smoke and browser E2E verification require a separately approved, manually dispatched GitHub Actions run with the cases, commit and live-provider usage stated. Backend fixture tests do not verify microphone capture, IndexedDB transactions, duplicate saves after an edit, or browser speech.

The correction fixture cases cover the Friday time change, replay of the same request, missing context, vague times, invalid provider actions and malformed reminder snapshots. The backend stops at the validated response.

## Read-only lookup provider layer

The existing Deepgram to `/api/commands` flow supports one read-only lookup at a time. Groq identifies its kind and arguments; Go validates them, retrieves facts and returns a lookup snapshot. A lookup cannot accompany reminder, draft, calendar or conversational-reply actions. The browser commits its answer and sources on the originating conversation turn before speaking. There is no separate lookup endpoint.

The API initializes one `newLookupService(providers, clock)` per API instance and uses `clientAddress(request)` for the visitor's rate-limit identity. Do not create a service per request, which would reset its limits. The model's internal lookup intent accepts these arguments:

```json
{"kind":"hotels","terms":"","place":"Jaipur railway station","today":false}
```

Kinds are `hotels`, `weather`, `news`, `web`, `time`, `wiki` and `briefing`. Weather, time and hotels use only `place` with empty `terms` and `today=false`. News and web require concise `terms`; news can also supply a location and `today`. Wiki uses `terms`, an empty `place` and `today=false`. Briefing uses `place`, empty `terms` and `today=true`. Send these minimal arguments to providers, never the conversation, contacts, reminder IDs or a visitor identity. Go never converts source data into actions or another tool request. Hotel results omit distances, rates and availability. Wikipedia and briefing remain read-only lookups; saved snapshots, playback and text export do not fetch fresh facts.

Successful lookup snapshots use a string `query`, `status` of `answered` or `empty`, `answer`, `speech`, `sources` and `looked_up_at`. There is no `title` field on `LookupResult`. The browser accepts up to 2000 Unicode characters in the answer, up to 240 in speech and at most three sources. Wiki and briefing answers may contain plain-text LF line breaks. Answered weather, time and briefing snapshots require `timezone` and `data_time`. Answered results need at least one source. Empty results may retain up to three useful links, but their answer and speech state that the requested fact is unconfirmed or the topic is ambiguous. An empty status never establishes a factual answer. A pending place question uses `lookup_context.query` for hotels, weather, time or briefing, with the same `today` rule as above. News and wiki do not use that place continuation. Lookup failures use the existing `{command_id,error:{code,message,retryable}}` envelope with an optional `Retry-After` header; they contain no executable actions. Parsing this shape does not establish source quality or freshness.

The command response always echoes `command_id` and has `actions: []` for a lookup. It contains either `lookup` with `clarification: null`, or a `clarification` with `lookup_context`. When location is missing, the question is `Which city or landmark?`, or `Which city?` for briefing. The browser stores that question and context in the same conversation. Its next spoken place reply sends `lookup_context` with the new command's transcript, ID, time and timezone, without contacts or saved-item context. Go extracts a location through the constrained place-only schema before calling `withLookupPlace`; the original lookup kind cannot become a write action. For an ambiguous city, extraction retains the known city when the reply supplies only a region/country, and can replace it when another city is spoken. A country with multiple time zones requires a city. Weather freshness, news windows and time answers use the server clock.

Weather/time/briefing resolution validates provider records and checks explicit region/country qualifiers. If multiple candidates remain, Groq receives only the location query and up to five candidates' public names, regions, countries, feature types and available populations in provider order. Its strict response can select an existing candidate index or null for clarification. Go checks the index and uses only that original provider record's coordinates and IANA timezone for the weather/time/briefing answer. The model cannot invent coordinates, facts, API arguments or actions. Fixed population cutoffs and country/city preference rules do not choose a candidate. Selection has an eight-second deadline within the existing 16-second lookup budget and public lookup rate limit. Selection failures return an honest error rather than silently choosing a place.

Search evidence must be a complete contiguous quote from a returned title or excerpt, allowing whitespace, case and typographic quote differences. Hotel names must occur in the selected supporting quote. Web answers must preserve a complete selected sentence or title. Word overlap, joins across title/excerpt, inserted ellipses and a cropped phrase within a negated sentence are not support. If no supported answer remains, Morning returns an honest empty result with useful source links. This is an extraction check, not a guarantee that the publisher is correct. Hindi translations use only accepted evidence and reject new numeric values; model translation accuracy is not established by that numeric check. Original evidence stays visible.

Tavily JSON and SSE envelopes remain bounded to 256 KiB. JSON results keep the existing publication timestamp formats and tracking-link deduplication. The ambiguous Detailed Results text format contributes only its first source link and excerpt. Later Title blocks may be excerpt text, so Morning does not promote them into citations. Text-format dates cannot establish news freshness. Confirmed headlines require structured JSON publication metadata within the requested local-day window. Missing or undated headlines stay unavailable rather than acquiring an invented timestamp.

Wikipedia tries the requested title on the selected language host before a search fallback. Each response, including a 404 body, is bounded to 256 KiB and shares the lookup deadline. Redirects are rejected, not followed. A missing exact title can use a single search match; multiple matches and disambiguation pages return an empty result asking for a specific topic, with at most three Wikipedia links and no ambiguity-page facts. Standard summaries use bounded plain text. Speech uses a complete short sentence or a localized source-ready message, never a cropped long claim. Sources stay on the requested HTTPS Wikipedia article host. The command API's empty language flag means English; `hi` chooses Hindi Wikipedia, without inferring reply language from the topic's script.

Briefings require an explicit city, including after a missing or ambiguous-place question. An IANA timezone is not the user's city. Weather and news use the same validated city selection; the news query includes its region and country. Weather `data_time` is the provider observation time, separate from `looked_up_at`. Both weather and briefing require matching provider timezone, Celsius and Unix-time units, a known WMO weather code, temperature within 100 degrees Celsius of zero, and an observation no older than two hours or more than 15 minutes ahead of the server clock. Unknown codes never become clear weather.

A briefing returns one weather citation and up to two dated headline citations. Headline snapshots include `window_start` and `window_end`; the browser requires dates within that window for every citation after the first weather source. Optional news failures preserve the weather result with an explicit headlines-unavailable message in English or Hindi. An empty confirmed-news window is stated separately. Weather or city-provider failures still use the retryable lookup error envelope and `Retry-After` when available. Provider text is never forwarded as an error. Saved snapshots remain readable without a wall-clock expiry or a provider refresh.

An answered snapshot has this shape. The example is synthetic:

```json
{
  "kind": "weather",
  "query": "Pune",
  "status": "answered",
  "answer": "Pune, Maharashtra, India: partly cloudy, 24.5 °C, as of 8:45 AM on 3 November local time, Asia/Kolkata. Weather by Open-Meteo.",
  "speech": "Pune, Maharashtra, India: partly cloudy, 24.5 °C, as of 8:45 AM on 3 November local time, Asia/Kolkata. Weather by Open-Meteo.",
  "sources": [{
    "title": "Current weather from Open-Meteo",
    "url": "https://open-meteo.com/",
    "publisher": "Open-Meteo"
  }],
  "looked_up_at": "2026-11-03T03:30:00Z",
  "timezone": "Asia/Kolkata",
  "data_time": "2026-11-03T08:45:00+05:30"
}
```

Empty results use `status: "empty"`, an honest answer and `sources: []`. Source rows contain `title`, safe HTTP(S) `url`, and `publisher`, with optional exact `excerpt` and `published_at`. Tavily publisher labels use source hostnames. News also includes `window_start`, `window_end` and the visitor's `timezone`; only stories with a timestamp in that window survive. Weather credits Open-Meteo and GeoNames and returns local `data_time`. Time answers use the server clock in the resolved IANA zone.

The frontend command parser calls `parseLookupResult` and rejects mixed lookup/action responses. `commitLookup` stores the entire snapshot and answer on the original turn in one IndexedDB transaction before speaking its `speech`, which is capped at 240 characters. The turn is also the receipt, so persistence retries retain the first saved answer. A failed save retains the transcript and cached command response for retry without another search. Switching conversations during retrieval preserves the original turn and suppresses speech in the background conversation. History reads local snapshots; Play reply uses only the speech path. Quick View renders source text as text and links through `safeLookupLink`, with `rel="noopener noreferrer"` for new tabs. Opening a source does not authorize Morning to fetch it or execute its contents.

Provider errors are `lookupError` values with a fixed `Code`, `Message`, `Retryable` and optional `RetryAfter`. These include missing search configuration, denied provider access, quota/rate limits, timeouts, invalid responses and outages. The command adapter maps these to the existing API error envelope with its command ID and forwards `Retry-After` when set. The browser preserves the transcript and applies a lookup-only cooldown to lookup retry buttons, leaving the mic available for other commands. Search and weather/time have independent provider limiters. Reminder, draft and speech paths do not require Tavily.

See the [public setup instructions](../README.md#read-only-lookup-setup) for the optional server-only Tavily key and Azure VM file. The MCP client supports JSON and SSE responses with bounded bodies and blocks redirects. It ignores server instructions and requests. Only protocol initialization and the search tool are sent. No MCP SDK or other Go dependency is needed.

Fixture definitions cover the provider transport, command integration, grounded hotel/Go results, location continuation, today filtering, weather units and data time, ambiguity, Tokyo time, quota/outage redaction, public rate limits, unsafe links, malformed output and attempted model tool calls. Browser fixtures cover snapshot validation, persistence, switching conversations, failed saves and speech-only replay. They have not been executed. The manual **Read-only lookup fixtures** workflow can run them at an approved commit without live keys. It has no push, PR, schedule or deployment trigger. Browser interaction, source quality and live provider behavior require separate verification.
