# Morning

Morning is a browser-based voice assistant for saving reminders and editable email drafts. Open the [landing page](https://morning.atuls.me/) or go straight to the [guest workspace](https://morning.atuls.me/app). No account is required.

**[Project documentation](docs/PROJECT.md)** follows the example below through the code and includes Atul Kumar's solo contribution and the verified Actions runs.

> Draft Priya an email asking for the slides, and remind me in ten minutes to follow up.

Click **Talk to Morning**, say the request, then click **Stop listening**. Priya Shah is a sample contact. Both saved results appear beneath the transcript. Click a row to open Quick View.

Then try "Change that reminder to two minutes" or "Make that email more detailed." Morning updates the same saved item. With several possible targets in the conversation, choose the one to edit. Greetings and questions such as "What can you do?" receive a Groq-generated reply without creating a reminder or draft.

## Run locally

You need Go 1.22 or newer, Node.js 22.12 or newer, and server-side Deepgram and Groq keys.

1. Follow the [Go API setup](server/README.md#local-startup). Copy `server/.env.example` to `server/.env`, fill in the keys and start the server.
2. In a second terminal, run `cd web`, `npm ci --ignore-scripts` and `npm run dev`.
3. Open the URL printed by Vite. `/` shows the landing page and `/app` opens the guest workspace. The development server proxies `/api` to Go at `127.0.0.1:8080`.

Keep provider keys in the server environment. The clonable product includes its source, lockfile, licenses, fixtures and setup guides.

## What is connected

The microphone streams to Deepgram for live captions using a temporary token from Go. Stop sends the final transcript, relevant contacts and focused reminder or draft context to Go. Groq interprets the request, writes or revises the email, or generates a conversational reply. New drafts are prompted to include a developed request and useful detail from the user's words. The browser saves validated results before requesting an ElevenLabs spoken reply. Browser speech provides a fallback. **Play reply** remains available to replay the current reply without rerunning its action.

Saved records, contacts and manual edits stay in this browser profile. Quick View supports editing, copying and plain-text download. **Send via Gmail** opens a compose window populated with the saved draft; you review it and press Send in Gmail. Due alerts stay visible until dismissed. A focused, visible dashboard can chime when browser audio is enabled, and **Play chime** is available manually. The owner can also [configure automatic Gmail reminders](deploy/README.md#owner-reminder-email). Wait until all email changes are scheduled before closing the tab, including after editing a due time. Accepted schedules survive closing the browser and deploying another release. Unpaired guests cannot schedule automatic mail to the owner's inbox.

Reminder Quick View offers **Download .ics** and **Add to Google Calendar**. Both create a one-minute entry at the saved due time. Review and save or import it in your calendar. Calendar copies do not sync with later edits in Morning.

The backend also implements calendar-event responses and meeting minutes. Their browser recording and event-scheduling flows are pending. Search, packaged local installation and phone sync are future work. The [project presentation](https://morning.atuls.me/presentation.html) explains today's demo and these plans separately. Local development is available now using the setup above and your own hosted-provider keys.

See the [web guide](web/README.md) for recorder controls, storage and retry behavior, the [API guide](server/README.md) for endpoint contracts, and the [deployment guide](deploy/README.md) for Azure setup and rollback.

## Verification

Authored tests and provider fixtures are included. Test execution requires separate approval and uses a manually dispatched workflow. Deployment performs compilation and service activation only. Browser behavior and live-provider behavior remain unverified for this release.
