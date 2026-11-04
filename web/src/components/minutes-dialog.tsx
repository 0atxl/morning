import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSummarize: (transcript: string) => Promise<string>;
  onSelectResult: (id: string) => void;
  onRestoreFocus: () => void;
};

export function MeetingMinutesDialog({
  open,
  onOpenChange,
  onSummarize,
  onSelectResult,
  onRestoreFocus,
}: Props) {
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const locked = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current) return;
    const text = transcript.trim();
    if (!text) {
      setError("Please paste or type meeting notes to summarize.");
      return;
    }
    locked.current = true;
    setSaving(true);
    setError("");
    try {
      const id = await onSummarize(text);
      setTranscript("");
      onOpenChange(false);
      onSelectResult(id);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Couldn't summarize the meeting. Please retry.",
      );
    } finally {
      locked.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="contacts-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <DialogTitle>Meeting Minutes</DialogTitle>
        <DialogDescription>
          Paste discussion notes or speak &ldquo;Take meeting minutes&hellip;&rdquo; into the microphone. Morning will extract a summary, decisions, action items, and open questions.
        </DialogDescription>
        <form onSubmit={submit} className="contact-form">
          <div className="field">
            <Label htmlFor="meeting-transcript">Meeting Discussion</Label>
            <Textarea
              id="meeting-transcript"
              value={transcript}
              onChange={(event) => setTranscript(event.target.value)}
              placeholder="e.g. We decided to launch the beta on Friday. Priya will send the slides by tomorrow. Atul will test the build. We haven't decided who runs QA."
              rows={8}
              maxLength={64000}
              required
              disabled={saving}
              autoFocus
            />
          </div>
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
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Summarizing…" : "Generate Minutes"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
