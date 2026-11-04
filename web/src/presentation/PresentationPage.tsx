import { useState, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import "./presentation.css";

// Adapted from Atul's TrialSync presentation in staticpages on alsomine.
// These examples explain the product. They never run commands or call providers.
const journey = [
  { id: "capture", title: "Speak", detail: "Live captions", x: 70, y: 90 },
  {
    id: "interpret",
    title: "Understand",
    detail: "Time + contacts",
    x: 290,
    y: 170,
  },
  { id: "save", title: "Save", detail: "In this browser", x: 510, y: 55 },
  { id: "review", title: "Review", detail: "Edit the result", x: 720, y: 210 },
  {
    id: "use",
    title: "Follow through",
    detail: "A reminder or draft",
    x: 940,
    y: 320,
  },
];

const talkingPoints = [
  "Start with the problem: a small task interrupts what I am doing.",
  "Open the guest dashboard. Show live captions, then stop recording.",
  "Show one saved reminder and its local due time.",
  "Draft Priya an email. Edit it, then open the saved text in Gmail. I press Send.",
  "Explain owner-only automatic reminder email separately from drafts.",
  "Close with my plan: a local installation and optional phone sync. Both are future work.",
];

function Module({
  id,
  title,
  label,
  children,
  open = false,
}: {
  id: string;
  title: string;
  label: string;
  children: ReactNode;
  open?: boolean;
}) {
  const [expanded, setExpanded] = useState(open);
  return (
    <Collapsible
      id={id}
      className="module"
      open={expanded}
      onOpenChange={setExpanded}
    >
      <h3>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="module-head">
            <span className="module-head-text">
              <span className="module-label">{label}</span>
              <span className="module-title">{title}</span>
            </span>
            <span className="module-toggle">
              {expanded ? "Hide" : "Open"}
              <ChevronDown aria-hidden="true" />
            </span>
          </Button>
        </CollapsibleTrigger>
      </h3>
      <CollapsibleContent className="module-body">
        <div className="module-body-inner">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="module-row">
      <div className="row-bar" />
      <div>
        <h4 className="row-label">{title}</h4>
        <div className="row-detail">{children}</div>
      </div>
    </div>
  );
}

export function PresentationPage() {
  const [checked, setChecked] = useState<number[]>([]);
  return (
    <div className="morning-presentation">
      <a href="#presentation-main" className="presentation-skip">
        Skip to presentation
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="wordmark" href="/">
            Morning
          </a>
          <nav className="presentation-nav" aria-label="Presentation links">
            <a href="#roadmap">Future plans</a>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="notes-trigger">
                  Talking points
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="presentation-notes"
                aria-label="Presentation talking points"
              >
                <h2>My demo flow</h2>
                <p>A speaking checklist. Progress lasts for this page visit.</p>
                {talkingPoints.map((text, index) => (
                  <Button
                    key={text}
                    variant="ghost"
                    className="check-item"
                    aria-pressed={checked.includes(index)}
                    onClick={() =>
                      setChecked((previous) =>
                        previous.includes(index)
                          ? previous.filter((item) => item !== index)
                          : [...previous, index],
                      )
                    }
                  >
                    <span className="check-box" aria-hidden="true">
                      {checked.includes(index) && <Check />}
                    </span>
                    <span>{text}</span>
                  </Button>
                ))}
              </PopoverContent>
            </Popover>
          </nav>
        </div>
      </header>

      <main id="presentation-main">
        <header className="hero wrap">
          <p className="byline">A voice assistant by Atul Kumar</p>
          <h1>
            A little less
            <br />
            to remember.
          </h1>
          <p className="sub">
            Turn a passing thought into a reminder or an email draft, without
            leaving it on your mental to-do list.
          </p>
          <div className="hero-actions">
            <Button asChild className="presentation-primary">
              <a href="/app">
                Try the guest demo <ArrowUpRight aria-hidden="true" />
              </a>
            </Button>
            <a href="https://github.com/0atxl/morning">Read the source</a>
          </div>
        </header>

        <figure
          className="trail-section wrap"
          aria-labelledby="journey-caption"
        >
          <div className="trail-scroll">
            <div className="trail-frame">
              <svg
                className="trail-svg"
                viewBox="0 0 1000 380"
                aria-hidden="true"
              >
                <ellipse
                  className="contour"
                  cx="500"
                  cy="340"
                  rx="620"
                  ry="100"
                />
                <ellipse
                  className="contour"
                  cx="470"
                  cy="260"
                  rx="500"
                  ry="140"
                />
                <ellipse
                  className="contour"
                  cx="440"
                  cy="170"
                  rx="380"
                  ry="150"
                />
                <ellipse
                  className="contour"
                  cx="400"
                  cy="80"
                  rx="260"
                  ry="120"
                />
                <path
                  className="path-main"
                  d="M70,90 C155,90 205,170 290,170 C375,170 430,55 510,55 C590,55 640,200 720,210 C800,220 860,310 940,320"
                />
              </svg>
              {journey.map((step) => (
                <div key={step.id}>
                  <Button
                    asChild
                    variant="ghost"
                    className="marker-btn"
                    style={{ left: `${step.x / 10}%`, top: `${step.y / 3.8}%` }}
                  >
                    <a
                      href={`#${step.id}`}
                      aria-label={`${step.title}: ${step.detail}`}
                    >
                      <span />
                    </a>
                  </Button>
                  <span
                    className="marker-label"
                    style={{
                      left: `${step.x / 10}%`,
                      top: `${step.y / 3.8 + 7}%`,
                    }}
                  >
                    <span className="d">{step.title}</span>
                    {step.detail}
                  </span>
                </div>
              ))}
              <span className="trail-note">Only confirm after the save.</span>
            </div>
          </div>
          <figcaption id="journey-caption">
            A thought becomes something I can act on. Select a stop to follow
            the flow.
          </figcaption>
        </figure>

        <div className="stats">
          <div className="wrap stats-row">
            <span>Guest access</span>
            <span>Browser-local records</span>
            <span>Reminders + editable drafts</span>
            <span>Built for the web</span>
          </div>
        </div>

        <section className="problem-section wrap" aria-labelledby="why-title">
          <h2 id="why-title">Small tasks are easy to lose.</h2>
          <div className="problem-grid">
            <div className="prob-card highlight">
              <h3>The interruption</h3>
              <p>
                I remember to drink water or ask for a slide deck while I am
                working on something else. Opening another app and typing it out
                breaks the flow.
              </p>
            </div>
            <div className="prob-card highlight">
              <h3>The follow-up</h3>
              <p>
                A draft alone does not remind me to come back. A reminder alone
                does not write the message. Morning can save both from one
                request.
              </p>
            </div>
          </div>
          <blockquote className="example-command">
            <p>
              "Draft Priya an email asking for the slides, and remind me in ten
              minutes to follow up."
            </p>
            <footer>
              An example command. Priya Shah is a labeled sample contact.
            </footer>
          </blockquote>
        </section>

        <section
          className="pipeline-section wrap"
          aria-labelledby="pipeline-title"
        >
          <h2 id="pipeline-title">From speech to a saved result.</h2>
          <p className="lede">
            The model proposes the action. The app validates it, saves it, then
            attempts a spoken confirmation.
          </p>
          <ol className="pipeline">
            <li className="pipe-step" id="capture">
              <h3 className="pipe-title">Speak</h3>
              <p>
                Click the mic or hold Right Ctrl. Deepgram supplies interim and
                final captions. Stop finishes the complete recording.
              </p>
              <span className="pipe-tag tag-brick">
                Deepgram · live transcription
              </span>
            </li>
            <li className="pipe-step" id="interpret">
              <h3 className="pipe-title">Understand</h3>
              <p>
                Groq interprets the words with the browser's time, timezone and
                relevant contacts. Go validates the returned actions.
              </p>
              <span className="pipe-tag tag-amber">
                Groq + Go · interpretation
              </span>
            </li>
            <li className="pipe-step" id="save">
              <h3 className="pipe-title">Save</h3>
              <p>
                IndexedDB commits the results and command receipt together.
                Retrying the same command reuses the saved records.
              </p>
              <span className="pipe-tag tag-teal">
                IndexedDB · local persistence
              </span>
            </li>
            <li className="pipe-step" id="review">
              <h3 className="pipe-title">Review</h3>
              <p>
                Open a result row in Quick View. Edit the reminder or draft.
                Voice replies use an ElevenLabs MP3 with browser speech
                fallback.
              </p>
              <span className="pipe-tag tag-navy">
                React · editable results
              </span>
            </li>
          </ol>
        </section>

        <section
          className="modules-section wrap"
          id="use"
          aria-labelledby="today-title"
        >
          <h2 id="today-title">What the demo does today.</h2>
          <p className="lede">
            No sign-in or personal API key is required for the public guest
            workspace. Saved records stay in that browser profile.
          </p>
          <Module
            id="reminders-today"
            title="Reminders I can inspect and change"
            label="Available in the guest dashboard"
            open
          >
            <Row title="Say the time naturally">
              <p>
                "Remind me to drink water in ten minutes." Morning uses the
                browser's timezone and shows the saved due date and time.
              </p>
            </Row>
            <Row title="Change the time by voice">
              <p>
                "Change that reminder to two minutes." Morning updates the same
                reminder. If several reminders could be the target, I choose the
                one to change.
              </p>
            </Row>
            <Row title="Put it on my calendar">
              <p>
                Quick View offers Download .ics and Add to Google Calendar. I
                review and save a one-minute entry at the reminder's due time.
                Calendar copies do not sync with later changes in Morning.
              </p>
            </Row>
            <Row title="Come back to the result">
              <p>
                Reminders survive refresh and closing the tab in the same
                browser profile. Due alerts stay pending until dismissed. A
                visible, focused dashboard can chime when browser sound is
                enabled.
              </p>
            </Row>
            <Row title="Optional owner email">
              <p>
                My privately paired browser can schedule automatic reminders to
                my configured Gmail inbox. The server must accept each new
                schedule or edit before I close the tab. Accepted schedules
                survive releases. Unpaired public guests cannot send automatic
                mail to that inbox.
              </p>
            </Row>
          </Module>
          <Module
            id="drafts-today"
            title="An email draft with the last word left to me"
            label="Available in the guest dashboard"
          >
            <Row title="Resolve the person">
              <p>
                "Draft Priya an email asking for the slides." Morning uses the
                local contact list. If two contacts match, it asks me to choose
                before saving.
              </p>
            </Row>
            <Row title="Review before sending">
              <p>
                I edit the recipient, subject and message in Quick View. Send
                via Gmail opens a populated compose window. I review it and
                press Send in Gmail. This is separate from automatic reminder
                emails.
              </p>
            </Row>
            <Row title="Refine the draft by voice">
              <p>
                "Make that email more detailed" or "change its subject." Groq
                revises the saved subject and message using my existing wording.
                It updates the same draft and preserves the recipient and
                reminder. New drafts are prompted to include useful detail from
                my request without inventing facts.
              </p>
            </Row>
            <Row title="Keep control of the record">
              <p>
                The draft remains available for copying or plain-text download.
                Replaying a spoken confirmation does not create another draft or
                reminder. Recording the sentence again starts a new command.
              </p>
            </Row>
          </Module>
          <Module
            id="trust-today"
            title="Feedback that follows the actual operation"
            label="Available in the guest dashboard"
          >
            <Row title="See what was heard">
              <p>
                Live captions come from transcription events, and the orb
                responds to microphone volume. Activity reports recording,
                interpretation, saving and playback events.
              </p>
            </Row>
            <Row title="Start a conversation or ask a read-only question">
              <p>
                I can say hello, ask what Morning can do, or ask a read-only
                question in English, Hindi or Hinglish for weather, local time,
                hotels, news or web facts. Lookup answers cite their sources and
                stay separate from saved reminders and drafts.
              </p>
            </Row>
            <Row title="Keep conversations separate">
              <p>
                History selects a conversation and its results. An in-flight
                command keeps its original conversation even when I switch to
                another session during processing.
              </p>
            </Row>
            <Row title="Recover without redoing the action">
              <p>
                The app attempts speech only after a new save. If audio is
                blocked, the saved result stays usable and Play reply replays
                playback. Microphone capture, audible sound and inbox delivery
                still need a check on the demo device.
              </p>
            </Row>
          </Module>
        </section>

        <section
          className="roadmap-section"
          id="roadmap"
          aria-labelledby="future-title"
        >
          <div className="wrap">
            <h2 id="future-title">Where I want to take Morning.</h2>
            <p className="lede">
              Future plans, separate from the hackathon demo. My goal is a
              personal assistant that starts on my computer and can follow me to
              my phone.
            </p>
            <Module
              id="local-plan"
              title="Run my own Morning locally"
              label="Planned · packaged installation"
              open
            >
              <Row title="Already possible for development">
                <p>
                  The React client and Go API can run locally today with my own
                  Deepgram and Groq keys. Speech and interpretation still use
                  hosted providers.
                </p>
              </Row>
              <Row title="What I want next">
                <p>
                  A straightforward local install with one startup command,
                  background reminder scheduling, and settings for my own
                  provider keys. I want to explore local speech and language
                  models so an offline mode can become an option.
                </p>
              </Row>
              <div className="module-deliverable">
                <h4>My intended daily use</h4>
                <p>
                  Keep Morning available while I work. Speak a task, save a
                  draft, and return to the work without opening another task
                  manager.
                </p>
              </div>
            </Module>
            <Module
              id="phone-plan"
              title="Continue on my phone"
              label="Planned · optional device sync"
            >
              <Row title="One task across my devices">
                <p>
                  Create a reminder at my desk, see it on my phone, and bring an
                  edit back to the computer. I want sync to be optional,
                  authenticated and explicit about which devices share data.
                </p>
              </Row>
              <Row title="The work still ahead">
                <p>
                  Device pairing, a shared record format, conflict handling and
                  mobile notifications need implementation. Today's
                  browser-local guest records do not sync, and this demo does
                  not promise phone alerts.
                </p>
              </Row>
              <div className="module-deliverable">
                <h4>The goal</h4>
                <p>
                  The same reminders and drafts on my computer and phone, with a
                  clear way to control access and disconnect a device.
                </p>
              </div>
            </Module>
            <Module
              id="next-actions"
              title="More of the work around a conversation"
              label="Planned · additional browser flows"
            >
              <Row title="Meeting minutes">
                <p>
                  The Go API can prepare structured minutes from a completed
                  transcript. A browser meeting recorder, minutes editor and
                  export flow are still to come.
                </p>
              </Row>
              <Row title="Calendar reminder markers">
                <p>
                  The dashboard saves an event's start as a reminder and exports
                  a one-minute calendar marker. The event end is not retained.
                  Full-duration scheduling and calendar sync remain future work.
                </p>
              </Row>
              <Row title="Personal integrations, later">
                <p>
                  Read-only voice lookups for weather, local time, hotels, news
                  and web facts work in today's guest demo. Approved write
                  integrations with external personal tools remain future work
                  requiring explicit permission and a visible result.
                </p>
              </Row>
            </Module>
          </div>
        </section>

        <section
          className="closing-section wrap"
          aria-labelledby="closing-title"
        >
          <h2 id="closing-title">Built to put the thought down.</h2>
          <p>
            I built Morning as a solo hackathon project. I chose the scope,
            designed the voice interaction and coordinated implementation and
            deployment. AI coding assistants helped with code, fixtures, reviews
            and documentation.
          </p>
          <p>
            The web demo runs on an Azure VM. Provider credentials stay on the
            Go server. GitHub Actions compiles and activates releases; a
            successful build is not proof of microphone, sound or inbox
            behavior.
          </p>
          <div className="hero-actions">
            <Button asChild className="presentation-primary">
              <a href="/app">
                Try Morning <ArrowUpRight aria-hidden="true" />
              </a>
            </Button>
            <a href="https://github.com/0atxl/morning/blob/main/docs/PROJECT.md">
              Read the project documentation
            </a>
          </div>
        </section>
      </main>
      <footer className="presentation-footer wrap">
        <span>Morning · Atul Kumar</span>
        <a href="/">Back to the landing page</a>
      </footer>
    </div>
  );
}
