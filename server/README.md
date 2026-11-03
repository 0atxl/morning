# Morning Go API

The guest reminder flow has two endpoints. The browser streams microphone audio directly to Deepgram, then sends the complete final transcript to Go once. Go asks Groq to interpret it and returns a validated reminder or a clarification question.

The browser makes the reminder real by committing it to IndexedDB using `command_id` as a unique key. Speak the confirmed time with browser speech synthesis only after that transaction commits. The API does not save reminders, schedule alerts or generate spoken confirmations.

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

Display the question without saving a reminder. This milestone has no conversational clarification state. Let the person record a complete revised command with a new ID and timestamp.

Keep the original ID, transcript, timestamp and timezone on an explicit retry of the same request. The server stores no command history and can call Groq again on a retry. IndexedDB must enforce uniqueness of the command ID in the same transaction that creates the reminder. A duplicate response must not create or announce another saved reminder. An error response contains no actions.

Go uses Groq's [strict JSON schema mode](https://console.groq.com/docs/structured-outputs) for `openai/gpt-oss-20b`. It then checks that the output contains one supported action or a clarification, a nonblank title up to 200 characters, a future timestamp, and the correct IANA offset at the due instant. UTC output uses `+00:00`. Unexpected fields, multiple actions, refusals, truncated output and tool calls are rejected. The transcript is sent as data in a separate user message. There are no tools or server-side action execution.

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

Command IDs allow 1 to 128 ASCII letters, digits, hyphens or underscores. Transcripts allow up to 8192 UTF-8 bytes. There is no automatic provider retry. Keys must stay in the server environment, without `VITE_` prefixes.

## Verification

Tests require explicit user confirmation for each run. No tests, live-provider probes or browser verification were run while implementing this milestone.

Formatting, compilation with `go build -buildvcs=false`, and static analysis with `go vet ./...` completed. These commands did not start the server or execute tests.

The proposed provider-fixture unit/API suite is `cd server && go test ./...`, only after confirmation. Its custom HTTP transport returns local `testdata/` fixtures and cannot reach live providers. It covers the 09:10 Kolkata result, missing-time clarification, displayable failures, rejected model output, UTC and daylight-saving offsets, request limits and token issuance limits. It does not verify transcription, microphone capture, IndexedDB persistence or browser speech.

Smoke and browser E2E verification must use a separately approved, manually dispatched GitHub Actions workflow. Agree on the cases, commit and any live provider usage before running it. No workflow is included or triggered by this backend.

The server stops at validated reminder responses. Reminder edits, email drafts, meeting minutes, accounts, server storage and speech endpoints are outside this milestone.
