# Morning

Morning is a browser-based personal voice assistant in development. This backend milestone includes a Go API for the guest reminder flow:

- `POST /api/voice/token` issues a short-lived Deepgram token for live captions.
- `POST /api/commands` uses Groq to turn a completed transcript into one validated reminder or a clarification question.

Follow [the server setup guide](server/README.md) to run the API locally. You need Go 1.22 or newer and server-side Deepgram and Groq API keys. Start with the credential-free `server/.env.example`.

The browser client is being built separately. The API returns reminder data; the client must save it before announcing success. This milestone has no reminder storage, alerts, email drafts or meeting minutes.

Test definitions and synthetic provider fixtures are included. Tests and live-provider behavior remain unverified.
