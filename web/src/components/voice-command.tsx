import { useEffect, useState, type Ref } from "react";
import { Check, CircleAlert, Mic } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { VoiceView } from "@/hooks/use-reminder-flow";
import { canToggleRecorder } from "@/lib/recorder-shortcut";
import { UnderOrbDotTranscript } from "@/components/dot-morph";
import { formatDue } from "@/lib/results";

type Props = {
  view: VoiceView;
  orbCore: Ref<HTMLSpanElement>;
  disabled: boolean;
  archive: boolean;
  onToggle: () => void;
  onRetry: () => void;
  onCancel: () => void;
  onRetrySpeech: () => void;
  onChooseContact: (id: string) => void;
  onChooseReminder: (id: string) => void;
  onChooseDraft: (id: string) => void;
  onOpenContacts: () => void;
};

export function VoiceCommand({
  view,
  orbCore,
  disabled,
  archive,
  onToggle,
  onRetry,
  onCancel,
  onRetrySpeech,
  onChooseContact,
  onChooseReminder,
  onChooseDraft,
  onOpenContacts,
}: Props) {
  const { phase, captions } = view;
  const listening = phase === "listening";
  const blocked = !canToggleRecorder(phase);
  const [clock, setClock] = useState(Date.now);
  const retryDeadline = Math.max(view.retryAt, view.lookupRetryAt ?? 0);

  useEffect(() => {
    if (!retryDeadline || phase !== "error") return;
    setClock(Date.now());
    const interval = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [retryDeadline, phase]);

  const wait = Math.max(0, Math.ceil((retryDeadline - clock) / 1000));
  const status =
    phase === "loading"
      ? "Loading saved results…"
      : phase === "requesting"
        ? "Allow microphone access in your browser."
        : phase === "connecting"
          ? "Connecting to transcription…"
          : phase === "finishing"
            ? "Finishing transcription…"
            : phase === "processing"
              ? view.status === "Searching"
                ? "Searching"
                : "Working…"
              : phase === "saving"
                ? "Saving in this browser…"
                : view.status;
  const label = listening
    ? "Stop listening"
    : phase === "requesting"
      ? "Microphone access"
      : phase === "connecting"
        ? "Connecting"
        : phase === "loading"
          ? "Loading"
          : phase === "finishing"
            ? "Finishing"
            : phase === "saving"
              ? "Saving"
              : phase === "processing"
                ? view.status === "Searching"
                  ? "Searching"
                  : "Processing"
                : "Talk to Morning";
  const hasWords = Boolean(captions.final || captions.interim);

  return (
    <section
      className="voice-area"
      data-listening={listening}
      aria-label="Voice command"
    >
      <h1 className="voice-heading">
        <Button
          variant="ghost"
          className="voice-trigger"
          onClick={onToggle}
          disabled={disabled || blocked || view.retryAt > clock}
          aria-pressed={listening}
          aria-describedby="capture-notice recorder-shortcut-description"
          aria-controls="command-transcript"
        >
          <span className="mic-orb" aria-hidden="true">
            <span className="orb-material" />
            <span className="orb-core" ref={orbCore}>
              <span className="orb-flow" />
            </span>
            <span className="orb-lens" />
          </span>
          <span className="voice-action">
            <Mic className="recorder-icon" aria-hidden="true" />
            <span>{label}</span>
            <span className="recorder-shortcut" aria-hidden="true">
              Hold Right Ctrl to talk
            </span>
          </span>
        </Button>
      </h1>
      <span id="recorder-shortcut-description" className="sr-only">
        Hold the physical Right Control key to talk while the dashboard has
        focus. Release to finish. Click the microphone for hands-free recording.
      </span>
      <UnderOrbDotTranscript
        text={
          hasWords
            ? [captions.final, captions.interim].filter(Boolean).join(" ")
            : ""
        }
        isTranscribing={listening}
        fallback={
          listening
            ? "Listening…"
            : archive
              ? "Earlier activity"
              : "Press the mic to start."
        }
      />
      <p id="capture-notice" className="capture-notice">
        {archive
          ? "Choose New session to record."
          : disabled
            ? "Please wait to start another recording."
            : "Audio goes to Deepgram. Your command, relevant contacts and saved item context go to Morning's server. Results stay in this browser."}
      </p>
      <div
        className={`command-status${status ? " is-visible" : ""}`}
        role="status"
        aria-live="polite"
      >
        {phase === "saved" ? <Check size={14} aria-hidden="true" /> : null}
        {status}
        {listening ? (
          <span className="sr-only">
            Microphone is recording. Press Stop listening to finish.
          </span>
        ) : null}
      </div>
      {view.playbackError || view.replyAvailable ? (
        <div className="voice-feedback feedback-line">
          {view.playbackError && <p role="status">{view.playbackError}</p>}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onRetrySpeech}
          >
            Play reply
          </Button>
        </div>
      ) : null}
      {["requesting", "connecting", "finishing", "processing"].includes(
        phase,
      ) ? (
        <Button variant="outline" className="capture-cancel" onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
      {phase === "clarification" ? (
        <div className="voice-feedback">
          <div className="feedback-line">
            <p role="status">{view.question}</p>
            {view.lookupContext && (
              <Button variant="outline" onClick={onCancel}>
                Cancel search
              </Button>
            )}
            {!view.options.length &&
            !view.reminderOptions.length &&
            !view.draftOptions.length ? (
              <Button variant="outline" onClick={onToggle}>
                Record again
              </Button>
            ) : null}
            {!view.options.length &&
            /contact|address|recipient/i.test(view.question) ? (
              <Button variant="outline" onClick={onOpenContacts}>
                Add contact
              </Button>
            ) : null}
          </div>
          {view.options.length ? (
            <div className="contact-choices" aria-label="Choose a contact">
              {view.options.map((option) => (
                <Button
                  key={option.contact_id}
                  variant="outline"
                  className="contact-choice"
                  onClick={() => onChooseContact(option.contact_id)}
                >
                  <span>{option.name}</span>
                  <span>{option.email}</span>
                </Button>
              ))}
            </div>
          ) : view.reminderOptions.length ? (
            <div className="contact-choices" aria-label="Choose a reminder">
              {view.reminderOptions.map((reminder) => (
                <Button
                  key={reminder.id}
                  variant="outline"
                  className="contact-choice"
                  disabled={wait > 0}
                  onClick={() => onChooseReminder(reminder.id)}
                >
                  <span>{reminder.title}</span>
                  <span>{formatDue(reminder, true)}</span>
                </Button>
              ))}
            </div>
          ) : view.draftOptions.length ? (
            <div className="contact-choices" aria-label="Choose an email draft">
              {view.draftOptions.map((draft) => (
                <Button
                  key={draft.id}
                  variant="outline"
                  className="contact-choice"
                  disabled={wait > 0}
                  onClick={() => onChooseDraft(draft.id)}
                >
                  <span>{draft.title}</span>
                  <span>{draft.subject}</span>
                </Button>
              ))}
            </div>
          ) : (
            <p className="revised-command">
              {view.lookupContext
                ? "Say the city or landmark to finish your search."
                : "Say the full revised command, including any reminder time."}
            </p>
          )}
        </div>
      ) : null}
      {view.error ? (
        <Alert variant="destructive" className="voice-error">
          <CircleAlert aria-hidden="true" />
          <AlertDescription className="feedback-line">
            <p>{view.error}</p>
            <Button
              variant="outline"
              onClick={onRetry}
              disabled={wait > 0 || blocked}
            >
              {wait > 0 ? `Retry in ${wait}s` : "Retry"}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {view.deliveryNotice ? (
        <p className="delivery-notice">{view.deliveryNotice}</p>
      ) : null}
    </section>
  );
}
