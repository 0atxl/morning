# Morning Go API

The guest voice flow has two endpoints. The browser streams microphone audio directly to Deepgram, then sends the complete final transcript to Go once. Go asks Groq to interpret it and returns a validated reminder, an editable email draft, both together, or a clarification question.

The browser makes the actions real by committing them to IndexedDB using `command_id` to prevent duplicate saves. Speak the saved result with browser speech synthesis only after that transaction commits. Drafts stay editable and unsent. The API does not save records, send email, schedule alerts or generate spoken confirmations.

## Local startup

Use Go 1.22 or newer. The server uses the standard library and embeds IANA timezone data. It needs no external Go modules or `go.sum`.

From the repository root:

```bash
cd server
cp .env.example .env
# Fill in the two keys in .env using your editor.
set -a
. ./.env
set +a
go run -buildvcs=false .
```

The default address is `127.0.0.1:8080`. Startup does not contact either provider. The shell loads `.env`; the Go process reads environment variables. `-buildvcs=false` also permits startup from a source snapshot without usable Git metadata. Keep `.env` out of Git. Production should inject secrets through the host's environment settings.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DEEPGRAM_API_KEY` | Yes | Permanent server-side Deepgram key with Member or higher permission to grant temporary tokens. |
| `GROQ_API_KEY` | Yes | Server-side Groq key for `openai/gpt-oss-20b`. |
| `LISTEN_ADDR` | No | Go listen address. Set `0.0.0.0:8080` when the hosting environment requires it. |

Use a same-origin `/api` proxy in the frontend development server, targeting `http://127.0.0.1:8080`. For Vite, the frontend session can set `server.proxy` to `{ "/api": "http://127.0.0.1:8080" }`. Production must serve the browser and `/api` on the same HTTPS origin. Go serves only the API, so the hosting layer must serve `web/` assets. No CORS configuration is needed for this arrangement.

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

Token issuance allows 5 requests per client IP and 60 total requests per server process per UTC minute. Commands allow 10 per IP and 120 total per minute. Attempts count even if a provider fails. `429` responses include a `Retry-After` header in seconds. Limits reset at minute boundaries and process restart. They are not shared between server instances.

The limiter trusts only the TCP peer IP. It ignores `X-Forwarded-For` and other guest-supplied headers. Behind a reverse proxy, requests share that proxy's IP allowance. Configure limits at the trusted ingress before a public deployment; do not enable arbitrary forwarded-IP trust.

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

### Saving and retries

Keep the original request on an explicit HTTP retry. The server stores no command history and can call Groq again. The browser must use one IndexedDB read/write transaction spanning reminders, drafts and command receipts. Check the unique receipt by `command_id`; if present, reuse its saved records and ignore the replay. Otherwise, create every returned record and add the receipt in that same transaction. One reminder and one draft can use the same ID in their separate stores.

If any write fails, abort all writes, including the receipt. Retrying after an abort can save the whole result. Retrying after a commit must preserve both records and any later draft edits. Account for existing reminder records when introducing command receipts. Speak only after the new transaction completes, and never announce another success on a replay. An error response contains no actions.

Go uses Groq's [strict JSON schema mode](https://console.groq.com/docs/structured-outputs) for `openai/gpt-oss-20b`. It checks action counts and fields, contact membership, text limits, future reminder timestamps and IANA offsets. UTC output uses `+00:00`. Unsupported actions, duplicate action types, mixed draft/reminder fields, refusals, truncated output and tool calls are rejected. Transcript and contact context are data in a separate user message. There are no tools or server-side action execution.

Groq interprets natural language and computes the requested due time. Go validates the structure and time constraints; it does not independently parse every spoken time expression. A fixture response establishes the intended contract, not live model accuracy.

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

Show `error.message` and retain the transcript. `command_id` is present when the command was parsed and its ID is valid. Token errors and errors rejected before command parsing omit it. Both endpoints return `Cache-Control: no-store`. Provider bodies, keys and transcripts are not logged.

| HTTP status | Error code | Meaning |
| --- | --- | --- |
| `400` | `invalid_request` | Malformed JSON, unknown fields or invalid command context. |
| `404` | `not_found` | Endpoint is outside this milestone. |
| `405` | `method_not_allowed` | Use POST. |
| `413` | `request_too_large` | Token body exceeds 1 KiB or command body exceeds 16 KiB. |
| `415` | `unsupported_media_type` | Send `application/json`. |
| `429` | `rate_limited` | Wait for `Retry-After` before retrying. |
| `502` | `voice_provider_unavailable`, `command_provider_unavailable` | Provider request failed. |
| `502` | `voice_provider_invalid_response`, `command_provider_invalid_response` | Provider output failed validation. |
| `504` | `voice_provider_timeout`, `command_provider_timeout` | Provider exceeded the 20-second HTTP timeout. |

Command and contact IDs allow 1 to 128 ASCII letters, digits, hyphens or underscores. Transcripts allow up to 8192 UTF-8 bytes. Supply at most 20 relevant contacts, each with a name up to 200 characters and a plain email address up to 254 characters. Reminder titles and draft subjects allow up to 200 characters. Draft bodies allow up to 8000 characters and can include line breaks. The whole command body still has a 16 KiB limit. There is no automatic provider retry. Keys must stay in the server environment, without `VITE_` prefixes.

## Verification

Tests require explicit user confirmation for each run and run only on GitHub Actions. The manually dispatched [Backend tests workflow](../.github/workflows/backend-tests.yml) runs the provider-fixture suite for an approved revision. It has no automatic triggers and needs no provider credentials. Do not run the suite locally or dispatch it without approval for that exact revision and scope.

The custom test transport returns local `testdata/` fixtures and cannot reach live providers. Cases cover a draft alone, the Friday compound command, contact ambiguity despite a confident model choice, valid and invalid selections, all-or-nothing output validation, the original reminder response, missing context, provider failures, timezones and token grants. The new draft cases have been authored but have not run. No provider probes, browser QA or CI were run for this change.

Smoke and browser E2E verification require a separately approved, manually dispatched GitHub Actions run with the cases, commit and live-provider usage stated. Backend fixture tests do not verify microphone capture, IndexedDB transactions, duplicate saves after an edit, or browser speech.

The server stops at validated reminder and draft responses. Reminder edits, meeting minutes, accounts, server storage, mail delivery and speech endpoints are outside this milestone.
