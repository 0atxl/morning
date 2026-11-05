import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { SpeechLanguage } from "@/lib/language";
import { minutesRequest } from "@/lib/minutes";

type Props = {
  open: boolean;
  sessionId: string;
  sessionLabel: string;
  initialTranscript?: string;
  initialLanguage?: SpeechLanguage;
  onOpenChange: (open: boolean) => void;
  onSummarize: (
    transcript: string,
    language: SpeechLanguage,
    sessionId: string,
  ) => Promise<string>;
  onSelectResult: (id: string) => void;
  onRestoreFocus: () => void;
};

export function MeetingMinutesDialog({
  open,
  sessionId,
  sessionLabel,
  initialTranscript = "",
  initialLanguage = "en",
  onOpenChange,
  onSummarize,
  onSelectResult,
  onRestoreFocus,
}: Props) {
  const [transcript, setTranscript] = useState("");
  const [language, setLanguage] = useState<SpeechLanguage>("en");
  const [owner, setOwner] = useState({ id: sessionId, label: sessionLabel });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const locked = useRef(false);
  const wasOpen = useRef(false);
  const openingResult = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setOwner({ id: sessionId, label: sessionLabel });
      openingResult.current = false;
      if (!transcript && initialTranscript) {
        setTranscript(initialTranscript);
        setLanguage(initialLanguage);
      }
    }
    wasOpen.current = open;
  }, [
    open,
    sessionId,
    sessionLabel,
    initialTranscript,
    initialLanguage,
    transcript,
  ]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current) return;
    locked.current = true;
    setSaving(true);
    setError("");
    try {
      minutesRequest(transcript, language);
      const id = await onSummarize(transcript, language, owner.id);
      setTranscript("");
      openingResult.current = true;
      onOpenChange(false);
      onSelectResult(id);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Couldn't save meeting minutes. Your notes are still here. Please retry.",
      );
    } finally {
      locked.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!locked.current) onOpenChange(next);
      }}
    >
      <DialogContent
        className="contacts-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!openingResult.current) onRestoreFocus();
        }}
      >
        <DialogTitle>Meeting minutes</DialogTitle>
        <DialogDescription>
          Paste notes or a completed spoken transcript. Morning summarizes the
          discussion without carrying out reminder or email instructions. This
          is not continuous or remote-meeting recording.
        </DialogDescription>
        <form onSubmit={submit} className="contact-form" aria-busy={saving}>
          <p className="field-hint">
            Save in {owner.label || "this conversation"}.
          </p>
          <fieldset className="result-editor" disabled={saving}>
            <legend>Minutes language</legend>
            <div
              className="contact-actions"
              role="group"
              aria-label="Minutes language"
            >
              <Button
                type="button"
                variant={language === "en" ? "default" : "outline"}
                aria-pressed={language === "en"}
                onClick={() => setLanguage("en")}
              >
                English
              </Button>
              <Button
                type="button"
                variant={language === "hi" ? "default" : "outline"}
                aria-pressed={language === "hi"}
                onClick={() => setLanguage("hi")}
              >
                हिंदी
              </Button>
            </div>
            <div className="field">
              <Label htmlFor="meeting-transcript">
                Meeting notes or completed transcript
              </Label>
              <Textarea
                id="meeting-transcript"
                value={transcript}
                onChange={(event) => setTranscript(event.target.value)}
                rows={8}
                required
                autoFocus
                aria-describedby="minutes-input-limit"
              />
              <p id="minutes-input-limit" className="field-hint">
                Up to 64 KiB including JSON encoding. Oversized notes are
                rejected, never shortened. Review generated minutes before using
                them.
              </p>
            </div>
          </fieldset>
          {error && (
            <p className="contact-error" role="alert">
              {error}
            </p>
          )}
          <div className="contact-actions">
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Generating and saving…" : "Generate minutes"}
            </Button>
          </div>
          {saving && (
            <p className="field-hint" role="status">
              Generating and saving minutes in {owner.label}. Keep this dialog
              open.
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
