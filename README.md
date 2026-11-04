# Morning

Morning is a browser-based voice assistant for reminders, editable email drafts and sourced answers. Open the [landing page](https://morning.atuls.me/) or go straight to the [guest workspace](https://morning.atuls.me/app). No account is required.

Speak English, Hindi or Hinglish with the same mic. Transcription uses Deepgram Nova-3 multilingual mode with English and Hindi hints. Hindi and Hinglish commands receive Hindi replies, including reminder confirmations and sourced lookup answers. Email drafts use the language you request. The dashboard controls stay in English.

Try "मुझे दस मिनट में पानी पीने की याद दिलाना", "Pune mein abhi mausam kaisa hai?", or "जयपुर रेलवे स्टेशन के पास तीन होटल ढूँढो". Hindi replies use the existing ElevenLabs setup; browser fallback depends on the voices installed on your device. Contact names must match their saved spelling. Add a contact with its Hindi spelling when transcription uses Devanagari; Morning does not guess identities across scripts.

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

The backend also implements calendar-event responses and meeting minutes. Their browser recording and event-scheduling flows are pending. Packaged local installation and phone sync are future work. The [project presentation](https://morning.atuls.me/presentation.html) explains today's demo and these plans separately. Local development is available now using the setup above and your own hosted-provider keys.

## Read-only lookup setup

The existing mic supports hotel, news and general web search through [Tavily's hosted MCP](https://docs.tavily.com/documentation/mcp), [Open-Meteo current weather](https://open-meteo.com/en/docs), and city time from the server clock and IANA time zones. Guests use Morning's server credentials and need no MCP client, provider account or key. Live-provider verification requires a separately approved check.

Say "Find three hotels near Jaipur railway station", "What's the weather in Pune right now?", or "What's the latest technology news in India today?" Then stop recording. The lookup shows Searching and saves an answer with its sources in that conversation before speaking. Open its result row for source links and times in Quick View. History and Play reply use the saved answer. For "hotels near me", answer "Which city or landmark?" by recording the place, or choose Cancel search. The same mic also handles "What's the latest stable Go release?" and "What time is it in Tokyo?".

Location follow-ups accept a short place name or a full spoken question. Morning extracts only the location while keeping the original lookup; it shows Waiting for location when another answer is needed. Weather values come from Open-Meteo. Clarification text and weather-condition translations are fixed wording; example cities in the instructions are not an allowed-city list or canned weather answers.

Voice requests already pass through Groq for intent and arguments. When geocoding finds multiple places, Groq also interprets the intended place from the provider's candidate records. Go accepts only a supplied candidate index or a clarification, then calls the API with the provider's validated coordinates. It does not pick cities using fixed population cutoffs, and the model does not supply weather facts from memory.

For local setup, add `TAVILY_API_KEY` to `server/.env`. On the existing Azure VM, edit **`/etc/morning/server.env`** with `sudoedit` and add `TAVILY_API_KEY` there. The `morning-api.service` systemd unit reads that file. Restart it with `sudo systemctl restart morning-api.service` when enabling the reviewed release. Keep the file's existing `root:morning` ownership and `0640` permissions. This is VM configuration, not an Azure App Service setting or GitHub Actions secret. Never put the key in a `VITE_` variable, browser storage or an MCP URL.

Go connects to `https://mcp.tavily.com/mcp/` with `Authorization: Bearer <TAVILY_API_KEY>` and calls only `tavily_search`. No additional Go modules are required, so Azure can continue compiling with `GOPROXY=off`. Open-Meteo weather and city-time resolution do not use a Tavily key. Missing keys and provider failures return fixed, displayable errors.

Lookups have a 12-second deadline, at most three sources, and separate per-minute budgets for search and weather/time. Each budget permits four lookups per visitor and 40 across the service. News requested for today uses midnight through the lookup's start in the visitor's IANA timezone, within a Tavily one-day search. Stories without a confirmed publication timestamp, outside that window or dated in the future are excluded. A source's publication time, weather's local data time and Morning's lookup time remain separate. Some MCP response formats omit publication dates; those results cannot establish today's news and produce an honest empty result. Live provider compatibility still needs verification.

The result contract and integration boundary are described in the [API guide](server/README.md#read-only-lookup-provider-layer).

See the [web guide](web/README.md) for recorder controls, storage and retry behavior, the [API guide](server/README.md) for endpoint contracts, and the [deployment guide](deploy/README.md) for Azure setup and rollback.

## Verification

Authored tests and provider fixtures are included. Test execution requires separate approval and uses a manually dispatched workflow. Deployment performs compilation and service activation only. Browser behavior and live-provider behavior remain unverified for this release.
