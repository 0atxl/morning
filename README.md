# Morning

[Project documentation](docs/PROJECT.md) covers the guest walkthrough, code trace, solo contribution, and verification evidence.

Morning is a browser-based voice assistant for saving reminders and editable email drafts. Open the [landing page](https://morning.atuls.me/) or go straight to the [guest workspace](https://morning.atuls.me/app). No account is required.

Try “Remind me in ten minutes to check the oven” or “Draft Priya an email asking her to confirm the revised timeline, and remind me Friday at ten AM to follow up.” Priya is a labeled example contact. You can add your own contacts in the workspace.

## Run locally

You need Go 1.22 or newer, Node.js 22.12 or newer, and server-side Deepgram and Groq keys.

1. Follow the [Go API setup](server/README.md#local-startup). Copy `server/.env.example` to `server/.env`, fill in the keys and start the server.
2. In a second terminal, run `cd web`, `npm ci --ignore-scripts` and `npm run dev`.
3. Open the URL printed by Vite. `/` shows the landing page and `/app` opens the guest workspace. The development server proxies `/api` to Go at `127.0.0.1:8080`.

Keep provider keys in the server environment. The clonable product includes its source, lockfile, licenses, fixtures and setup guides.

## What is connected

The microphone streams to Deepgram for live captions using a temporary token from Go. Stop sends the final transcript and relevant contacts to Go, which uses Groq to interpret the command. The browser saves validated reminders and drafts together in IndexedDB, then speaks the saved result using browser speech synthesis.

Saved records, contacts and manual edits stay in this browser profile. Quick View supports editing, copying and plain-text download. Drafts remain unsent. Reminder alerts and background notifications are pending.

The backend also implements reminder corrections, calendar-event responses, meeting minutes and optional ElevenLabs MP3 speech. Their browser integrations are pending, including calendar `.ics` download. PAD and PEN in Design preview are sample states. Search and account sync are deferred. The landing page's presentation link currently opens a placeholder page.

See the [web guide](web/README.md) for recorder controls, storage and retry behavior, the [API guide](server/README.md) for endpoint contracts, and the [deployment guide](deploy/README.md) for Azure setup and rollback.

## Verification

Authored tests and provider fixtures are included. Test execution requires separate approval and uses a manually dispatched workflow. Deployment performs compilation and service activation only. Browser behavior and live-provider behavior remain unverified for this release.
