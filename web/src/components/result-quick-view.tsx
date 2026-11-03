import { useRef, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Pencil,
  Search,
  Volume2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  downloadResult,
  formatDue,
  gmailComposeUrl,
  googleCalendarUrl,
  localInputDate,
  resultText,
  type WorkspaceResult,
} from "@/lib/results";
import { safeLookupLink, type LookupResult } from "@/lib/lookup-result";

type Props = {
  result: WorkspaceResult | null;
  results: WorkspaceResult[];
  onSelect: (id: string | null) => void;
  onSave: (result: WorkspaceResult) => Promise<void>;
  onRestoreFocus: () => void;
  onPlayReply: (text: string) => void;
};

export function ResultQuickView({
  result,
  results,
  onSelect,
  onSave,
  onRestoreFocus,
  onPlayReply,
}: Props) {
  const content = useRef<HTMLDivElement>(null);
  const index = results.findIndex((item) => item.id === result?.id);
  const previous = results[index - 1];
  const next = results[index + 1];

  return (
    <Dialog
      open={result !== null}
      onOpenChange={(open) => {
        if (!open) onSelect(null);
      }}
    >
      <DialogContent
        ref={content}
        className="quick-view"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          content.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
            return;
          const target = event.target as HTMLElement;
          if (
            target.closest('input, textarea, select, [contenteditable="true"]')
          )
            return;
          if (event.key === "ArrowLeft" && previous) {
            event.preventDefault();
            onSelect(previous.id);
          } else if (event.key === "ArrowRight" && next) {
            event.preventDefault();
            onSelect(next.id);
          } else if (event.code === "Space" && !target.closest("button, a")) {
            event.preventDefault();
            if (!event.repeat) onSelect(null);
          }
        }}
      >
        <div className="quick-view-header">
          <DialogTitle className="quick-view-title">
            {result?.kind === "lookup" ? (
              <Search aria-hidden="true" />
            ) : result?.kind === "draft" ? (
              <FileText aria-hidden="true" />
            ) : (
              <CalendarClock aria-hidden="true" />
            )}
            <span>{result?.title ?? "Quick View"}</span>
          </DialogTitle>
          <div className="quick-view-navigation" aria-label="Browse results">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Previous result"
                  disabled={!previous}
                  onClick={() => previous && onSelect(previous.id)}
                >
                  <ChevronLeft />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Previous result</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Next result"
                  disabled={!next}
                  onClick={() => next && onSelect(next.id)}
                >
                  <ChevronRight />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Next result</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <DialogDescription className="sr-only">
          {result?.sample ? "Sample result. " : "Saved in this browser. "}Press
          Escape or Space to close. Use left and right arrows to browse results.
        </DialogDescription>
        {result ? (
          <ResultContent
            key={result.id}
            result={result}
            onSave={onSave}
            onPlayReply={onPlayReply}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ResultContent({
  result,
  onSave,
  onPlayReply,
}: {
  result: WorkspaceResult;
  onSave: Props["onSave"];
  onPlayReply: Props["onPlayReply"];
}) {
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [actionError, setActionError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [title, setTitle] = useState(result.title);
  const [due, setDue] = useState(
    result.kind === "reminder" ? localInputDate(result.dueAt) : "",
  );
  const [to, setTo] = useState(result.kind === "draft" ? result.to : "");
  const [subject, setSubject] = useState(
    result.kind === "draft" ? result.subject : "",
  );
  const [body, setBody] = useState(result.kind === "draft" ? result.body : "");

  function beginEdit() {
    if (result.kind === "lookup") return;
    setTitle(result.title);
    if (result.kind === "reminder") setDue(localInputDate(result.dueAt));
    else {
      setTo(result.to);
      setSubject(result.subject);
      setBody(result.body);
    }
    setFeedback("");
    setActionError("");
    setEditing(true);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || savingRef.current || result.kind === "lookup") return;
    setActionError("");
    let updated: WorkspaceResult;
    if (result.kind === "reminder") {
      const date = new Date(due);
      if (!title.trim() || Number.isNaN(date.getTime())) {
        setActionError("Enter a title and a valid date and time.");
        return;
      }
      updated = {
        ...result,
        title: title.trim(),
        dueAt: date.toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    } else {
      if (!to.trim() || !subject.trim() || !body.trim()) {
        setActionError("Enter a recipient, subject and message.");
        return;
      }
      updated = {
        ...result,
        to: to.trim(),
        recipient: to.trim() === result.to ? result.recipient : to.trim(),
        title: to.trim() === result.to ? result.title : `Draft to ${to.trim()}`,
        subject: subject.trim(),
        body: body.trim(),
      };
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await onSave(updated);
      setEditing(false);
      setFeedback(result.sample ? "Saved in preview" : "Saved in this browser");
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Couldn't save your changes. Please retry.",
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function copy() {
    setFeedback("");
    setActionError("");
    try {
      await navigator.clipboard.writeText(resultText(result));
      setFeedback("Copied");
    } catch {
      setActionError("Couldn't copy. Select the text or download it instead.");
    }
  }

  function download(format: "txt" | "ics" = "txt") {
    setActionError("");
    try {
      downloadResult(result, format);
      setFeedback("Download prepared");
    } catch {
      setActionError("Couldn't prepare the download. Copy the text instead.");
    }
  }

  return (
    <form onSubmit={save} className="quick-view-form">
      <div className="quick-view-body">
        {editing ? (
          <fieldset className="result-editor" disabled={saving}>
            {result.kind === "reminder" ? (
              <>
                <div className="field">
                  <Label htmlFor="result-title">Reminder</Label>
                  <Input
                    id="result-title"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={200}
                    required
                    autoFocus
                  />
                </div>
                <div className="field">
                  <Label htmlFor="result-due">Date and time</Label>
                  <Input
                    id="result-due"
                    type="datetime-local"
                    value={due}
                    onChange={(event) => setDue(event.target.value)}
                    required
                    aria-describedby="result-timezone"
                  />
                  <p id="result-timezone" className="field-hint">
                    {Intl.DateTimeFormat().resolvedOptions().timeZone}
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="field">
                  <Label htmlFor="draft-to">To</Label>
                  <Input
                    id="draft-to"
                    type="email"
                    value={to}
                    onChange={(event) => setTo(event.target.value)}
                    required
                    autoFocus
                  />
                </div>
                <div className="field">
                  <Label htmlFor="draft-subject">Subject</Label>
                  <Input
                    id="draft-subject"
                    value={subject}
                    onChange={(event) => setSubject(event.target.value)}
                    maxLength={200}
                    required
                  />
                </div>
                <div className="field">
                  <Label htmlFor="draft-body">Message</Label>
                  <Textarea
                    id="draft-body"
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                    rows={7}
                    maxLength={8000}
                    required
                  />
                </div>
              </>
            )}
          </fieldset>
        ) : result.kind === "lookup" ? (
          <LookupContent lookup={result.lookup} />
        ) : result.kind === "draft" ? (
          <>
            <dl className="draft-metadata">
              <div>
                <dt>To</dt>
                <dd>
                  {result.recipient}{" "}
                  <span className="muted">&lt;{result.to}&gt;</span>
                </dd>
              </div>
              <div>
                <dt>Subject</dt>
                <dd>{result.subject}</dd>
              </div>
            </dl>
            <p className="draft-body">{result.body}</p>
            <p className="delivery-notice">Review and send in Gmail.</p>
          </>
        ) : (
          <div className="reminder-details">
            <p className="detail-label">Due</p>
            <p className="reminder-due">
              <time dateTime={result.dueAt}>{formatDue(result, true)}</time>
            </p>
            <p className="field-hint">{result.timezone}</p>
            <p className="field-hint">
              Calendar export creates a one-minute event. Later edits in Morning
              do not update your calendar.
            </p>
          </div>
        )}

        {!editing ? (
          <Collapsible className="source-transcript">
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm">
                Transcript <ChevronDown aria-hidden="true" />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <p>{result.transcript}</p>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        {actionError ? (
          <p className="action-error" role="alert">
            {actionError}
          </p>
        ) : null}
      </div>

      <div className="quick-view-footer">
        <p className="quick-view-feedback" role="status">
          {feedback ? (
            <>
              <Check size={14} aria-hidden="true" />
              {feedback}
            </>
          ) : (
            <span>
              {result.sample ? "Sample result" : "Saved in this browser"}
            </span>
          )}
        </p>
        <div className="quick-view-actions">
          {editing ? (
            <>
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setActionError("");
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </>
          ) : (
            <>
              {result.kind === "lookup" ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onPlayReply(result.lookup.speech)}
                >
                  <Volume2 /> Play reply
                </Button>
              ) : (
                <Button type="button" variant="outline" onClick={beginEdit}>
                  <Pencil />
                  Edit
                </Button>
              )}
              <Button type="button" variant="outline" onClick={copy}>
                <Copy />
                Copy
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => download()}
              >
                <Download />
                Download
              </Button>
              {result.kind === "draft" ? (
                <Button asChild variant="outline">
                  <a
                    href={gmailComposeUrl(result)}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Send via Gmail (opens in a new tab)"
                  >
                    <ArrowUpRight aria-hidden="true" />
                    Send via Gmail
                  </a>
                </Button>
              ) : result.kind === "reminder" ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => download("ics")}
                  >
                    <CalendarClock />
                    Download .ics
                  </Button>
                  <Button asChild variant="outline">
                    <a
                      href={googleCalendarUrl(result)}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Add to Google Calendar (opens in a new tab)"
                    >
                      <ArrowUpRight aria-hidden="true" />
                      Add to Google Calendar
                    </a>
                  </Button>
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
    </form>
  );
}

function lookupTime(instant: string, timezone?: string) {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(new Date(instant));
}

function LookupContent({ lookup }: { lookup: LookupResult }) {
  return (
    <div className="lookup-details">
      <p className="draft-body">{lookup.answer}</p>
      <dl className="draft-metadata">
        <div>
          <dt>Looked up</dt>
          <dd>
            <time dateTime={lookup.looked_up_at}>
              {lookupTime(lookup.looked_up_at, lookup.timezone)}
            </time>
          </dd>
        </div>
        {lookup.data_time && (
          <div>
            <dt>Data time</dt>
            <dd>
              <time dateTime={lookup.data_time}>
                {lookupTime(lookup.data_time, lookup.timezone)}
              </time>
            </dd>
          </div>
        )}
        {lookup.window_start && lookup.window_end && (
          <div>
            <dt>News window</dt>
            <dd>
              {lookupTime(lookup.window_start, lookup.timezone)} to{" "}
              {lookupTime(lookup.window_end, lookup.timezone)}
            </dd>
          </div>
        )}
      </dl>
      {lookup.sources.length > 0 && (
        <ul className="lookup-sources" aria-label="Sources">
          {lookup.sources.map((source, index) => {
            const href = safeLookupLink(source.url);
            if (!href) return null;
            return (
              <li key={`${source.url}:${index}`}>
                <Button
                  asChild
                  variant="outline"
                  className="lookup-source-link"
                >
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${source.title} (opens in a new tab)`}
                  >
                    <span>{source.title}</span>
                    <ArrowUpRight aria-hidden="true" />
                  </a>
                </Button>
                <p className="field-hint">{source.publisher}</p>
                {source.published_at && (
                  <p className="field-hint">
                    Published{" "}
                    <time dateTime={source.published_at}>
                      {lookupTime(source.published_at, lookup.timezone)}
                    </time>
                  </p>
                )}
                {source.excerpt && (
                  <p className="field-hint">{source.excerpt}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
