import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  CalendarClock,
  Check,
  ChevronDown,
  Copy,
  Download,
  Pencil,
  Volume2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  confirmedReminderInstant,
  minutesSpeech,
  parseMeetingMinutes,
} from "@/lib/minutes";
import {
  downloadResult,
  minutesComposeUrl,
  resultText,
  type MeetingActionItem,
  type MeetingMinutes,
  type MinutesResult,
  type WorkspaceResult,
} from "@/lib/results";

type Props = {
  result: MinutesResult;
  onSave: (result: WorkspaceResult) => Promise<void>;
  onPlayReply: (text: string, language?: "en" | "hi") => void;
  onCreateReminder?: (
    minutesId: string,
    actionItemId: string,
    title: string,
    dueAt: string,
  ) => Promise<void>;
  onSelectReminder: (id: string) => void;
};

type ReminderDraft = {
  itemId: string;
  title: string;
  localDue: string;
  error: string;
};

function editableMinutes(minutes: MeetingMinutes): MeetingMinutes {
  return {
    ...minutes,
    decisions: [...minutes.decisions],
    action_items: minutes.action_items.map((item, index) => ({
      ...item,
      id: item.id ?? `item:${index}`,
    })),
    open_questions: [...minutes.open_questions],
  };
}

export function MinutesResultContent({
  result,
  onSave,
  onPlayReply,
  onCreateReminder,
  onSelectReminder,
}: Props) {
  const id = useId();
  const editorId = `${id}-editor`;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => editableMinutes(result.minutes));
  const [savedShadow, setSavedShadow] = useState<{
    source: MinutesResult;
    value: MinutesResult;
  } | null>(null);
  // Use the committed edit until the parent supplies its refreshed saved record.
  const saved = savedShadow?.source === result ? savedShadow.value : result;
  const [saving, setSaving] = useState(false);
  const [reminderDraft, setReminderDraft] = useState<ReminderDraft | null>(
    null,
  );
  const [creatingReminder, setCreatingReminder] = useState(false);
  const [pendingReminderItemId, setPendingReminderItemId] = useState<
    string | null
  >(null);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const mutationLock = useRef(false);
  const firstInput = useRef<HTMLInputElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const restoreEditFocus = useRef(false);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const removedLinkedItem = saved.minutes.action_items.some(
    (item, index) =>
      item.reminderId &&
      !draft.action_items.some(
        (edited) => edited.id === (item.id ?? `item:${index}`),
      ),
  );

  useEffect(() => {
    if (editing) firstInput.current?.focus();
    else if (restoreEditFocus.current && !reminderDraft && !creatingReminder) {
      editButton.current?.focus();
      restoreEditFocus.current = false;
    }
  }, [editing, reminderDraft, creatingReminder]);

  useEffect(() => {
    if (!pendingReminderItemId) return;
    const item = saved.minutes.action_items.find(
      (entry, index) => (entry.id ?? `item:${index}`) === pendingReminderItemId,
    );
    if (!item || item.reminderId) setPendingReminderItemId(null);
  }, [pendingReminderItemId, saved.minutes.action_items]);

  function beginEdit() {
    if (mutationLock.current) return;
    setDraft(editableMinutes(saved.minutes));
    setReminderDraft(null);
    setFeedback("");
    setError("");
    setEditing(true);
  }

  function cancelEdit() {
    if (mutationLock.current) return;
    setDraft(editableMinutes(saved.minutes));
    setError("");
    setFeedback("Showing saved minutes");
    restoreEditFocus.current = true;
    setEditing(false);
  }

  function updateItem(index: number, changes: Partial<MeetingActionItem>) {
    setDraft((current) => ({
      ...current,
      action_items: current.action_items.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...changes } : item,
      ),
    }));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || mutationLock.current) return;
    mutationLock.current = true;
    setSaving(true);
    setError("");
    setFeedback("");
    try {
      const minutes = parseMeetingMinutes({
        summary: draft.summary.trim(),
        decisions: draft.decisions.map((line) => line.trim()),
        action_items: draft.action_items.map((item) => ({
          task: item.task.trim(),
          owner: item.owner?.trim() || null,
          deadline: item.deadline?.trim() || null,
        })),
        open_questions: draft.open_questions.map((line) => line.trim()),
      });
      const updated: MinutesResult = {
        ...saved,
        minutes: {
          ...minutes,
          action_items: minutes.action_items.map((item, index) => ({
            ...draft.action_items[index],
            ...item,
          })),
        },
      };
      await onSave(updated);
      setSavedShadow({ source: result, value: updated });
      setFeedback(
        `${saved.sample ? "Saved in preview" : "Saved in this browser"}${removedLinkedItem ? ". Existing reminders were kept." : ""}`,
      );
      restoreEditFocus.current = true;
      setEditing(false);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Couldn't save the minutes. Your edits are still here. Please retry.",
      );
    } finally {
      mutationLock.current = false;
      setSaving(false);
    }
  }

  function prepareReminder(item: MeetingActionItem, index: number) {
    const itemId = item.id ?? `item:${index}`;
    if (
      editing ||
      mutationLock.current ||
      item.reminderId ||
      pendingReminderItemId === itemId
    )
      return;
    setReminderDraft({
      itemId,
      title: item.task,
      localDue: "",
      error:
        [...item.task.trim()].length > 200
          ? "Shorten the reminder title to 200 characters or fewer before confirming."
          : "",
    });
    setFeedback("");
    setError("");
  }

  async function confirmReminder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      editing ||
      mutationLock.current ||
      !reminderDraft ||
      !onCreateReminder ||
      pendingReminderItemId === reminderDraft.itemId
    )
      return;
    const item = saved.minutes.action_items.find(
      (entry, index) => (entry.id ?? `item:${index}`) === reminderDraft.itemId,
    );
    if (!item || item.reminderId) return;
    mutationLock.current = true;
    setCreatingReminder(true);
    setFeedback("");
    setReminderDraft((current) => current && { ...current, error: "" });
    try {
      const title = reminderDraft.title.trim();
      if (
        !title ||
        [...title].length > 200 ||
        /[\p{Cc}\p{Zl}\p{Zp}]/u.test(title)
      ) {
        throw new Error(
          "Enter a reminder title of 1 to 200 characters on one line.",
        );
      }
      const dueAt = confirmedReminderInstant(reminderDraft.localDue);
      await onCreateReminder(saved.id, reminderDraft.itemId, title, dueAt);
      // Keep the row saved until props supply the persisted reminder link.
      setPendingReminderItemId(reminderDraft.itemId);
      restoreEditFocus.current = true;
      setReminderDraft(null);
      setFeedback("Reminder saved");
    } catch (failure) {
      setReminderDraft((current) =>
        current
          ? {
              ...current,
              error:
                failure instanceof Error
                  ? failure.message
                  : "Couldn't save the reminder. Please retry.",
            }
          : current,
      );
    } finally {
      mutationLock.current = false;
      setCreatingReminder(false);
    }
  }

  async function copy() {
    if (editing) return;
    setFeedback("");
    setError("");
    try {
      await navigator.clipboard.writeText(resultText(saved));
      setFeedback("Copied");
    } catch {
      setError("Couldn't copy. Select the text or download it instead.");
    }
  }

  function download() {
    if (editing) return;
    setError("");
    try {
      downloadResult(saved);
      setFeedback("Download prepared");
    } catch {
      setError("Couldn't prepare the download. Copy the text instead.");
    }
  }

  function textEditor(
    section: "decisions" | "open_questions",
    heading: string,
    label: string,
  ) {
    return (
      <fieldset className="result-editor">
        <legend className="detail-label">{heading}</legend>
        {draft[section].map((line, index) => (
          <div className="field" key={index}>
            <Label htmlFor={`${id}-${section}-${index}`}>
              {label} {index + 1}
            </Label>
            <Input
              id={`${id}-${section}-${index}`}
              value={line}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  [section]: current[section].map((entry, entryIndex) =>
                    entryIndex === index ? event.target.value : entry,
                  ),
                }))
              }
              aria-describedby={`${id}-editor-help`}
              required
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  [section]: current[section].filter(
                    (_, entryIndex) => entryIndex !== index,
                  ),
                }))
              }
            >
              Remove {label.toLowerCase()}
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={draft[section].length >= 20}
          onClick={() =>
            setDraft((current) =>
              current[section].length >= 20
                ? current
                : { ...current, [section]: [...current[section], ""] },
            )
          }
        >
          Add {label.toLowerCase()}
        </Button>
      </fieldset>
    );
  }

  return (
    <div className="quick-view-form">
      <div className="quick-view-body">
        {editing ? (
          <form id={editorId} onSubmit={save} aria-busy={saving} noValidate>
            <fieldset className="result-editor" disabled={saving}>
              <legend className="sr-only">Edit meeting minutes</legend>
              <p id={`${id}-editor-help`} className="field-hint">
                Use one line per field. Each list can have up to 20 entries.
                Limits are 800 characters for the summary, 500 for each task,
                decision or open question, and 200 for each owner or deadline.
                Leave an unstated owner or deadline empty.
              </p>
              <div className="field">
                <Label htmlFor={`${id}-summary`}>Summary</Label>
                <Input
                  ref={firstInput}
                  id={`${id}-summary`}
                  value={draft.summary}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      summary: event.target.value,
                    }))
                  }
                  aria-describedby={`${id}-editor-help`}
                  required
                  autoFocus
                />
              </div>
              {textEditor("decisions", "Decisions", "Decision")}
              <fieldset className="result-editor">
                <legend className="detail-label">Action items</legend>
                {draft.action_items.map((item, index) => (
                  <fieldset className="result-editor" key={item.id}>
                    <legend className="detail-label">
                      Action item {index + 1}
                    </legend>
                    <div className="field">
                      <Label htmlFor={`${id}-task-${index}`}>Task</Label>
                      <Input
                        id={`${id}-task-${index}`}
                        value={item.task}
                        onChange={(event) =>
                          updateItem(index, { task: event.target.value })
                        }
                        aria-describedby={`${id}-editor-help`}
                        required
                      />
                    </div>
                    <div className="field">
                      <Label htmlFor={`${id}-owner-${index}`}>Owner</Label>
                      <Input
                        id={`${id}-owner-${index}`}
                        value={item.owner ?? ""}
                        onChange={(event) =>
                          updateItem(index, {
                            owner: event.target.value || null,
                          })
                        }
                        aria-describedby={`${id}-editor-help`}
                      />
                    </div>
                    <div className="field">
                      <Label htmlFor={`${id}-deadline-${index}`}>
                        Extracted deadline
                      </Label>
                      <Input
                        id={`${id}-deadline-${index}`}
                        value={item.deadline ?? ""}
                        onChange={(event) =>
                          updateItem(index, {
                            deadline: event.target.value || null,
                          })
                        }
                        aria-describedby={`${id}-editor-help ${id}-deadline-help-${index}`}
                      />
                      <p
                        id={`${id}-deadline-help-${index}`}
                        className="field-hint"
                      >
                        {item.deadline
                          ? "This text does not schedule a reminder."
                          : "Not stated. This does not schedule a reminder."}
                      </p>
                    </div>
                    {item.reminderId && (
                      <p id={`${id}-linked-${index}`} className="field-hint">
                        Reminder saved. Editing or removing this action item
                        leaves its reminder unchanged. Open the saved reminder
                        after saving or canceling to change its title or
                        schedule.
                      </p>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove action item ${index + 1}`}
                      aria-describedby={
                        item.reminderId ? `${id}-linked-${index}` : undefined
                      }
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          action_items: current.action_items.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        }))
                      }
                    >
                      Remove action item
                    </Button>
                  </fieldset>
                ))}
                {removedLinkedItem && (
                  <p className="field-hint">
                    Removed action items leave their saved reminders in place.
                  </p>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={draft.action_items.length >= 20}
                  onClick={() => {
                    const item: MeetingActionItem = {
                      id: crypto.randomUUID(),
                      task: "",
                      owner: null,
                      deadline: null,
                    };
                    setDraft((current) =>
                      current.action_items.length >= 20
                        ? current
                        : {
                            ...current,
                            action_items: [...current.action_items, item],
                          },
                    );
                  }}
                >
                  Add action item
                </Button>
              </fieldset>
              {textEditor("open_questions", "Open questions", "Open question")}
            </fieldset>
          </form>
        ) : (
          <>
            <div className="minutes-details result-editor">
              <div className="field">
                <p className="detail-label">Summary</p>
                <p className="draft-body">{saved.minutes.summary}</p>
              </div>
              <div className="field">
                <p className="detail-label">Decisions</p>
                {saved.minutes.decisions.length ? (
                  <ul className="lookup-sources" aria-label="Decisions">
                    {saved.minutes.decisions.map((line, index) => (
                      <li key={index}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="field-hint">None stated.</p>
                )}
              </div>
              <div className="field">
                <p className="detail-label">Action items</p>
                {saved.minutes.action_items.length ? (
                  <ul className="lookup-sources" aria-label="Action items">
                    {saved.minutes.action_items.map((item, index) => {
                      const itemId = item.id ?? `item:${index}`;
                      const reminderId = item.reminderId;
                      const confirmation =
                        reminderDraft?.itemId === itemId && !reminderId
                          ? reminderDraft
                          : null;
                      return (
                        <li className="field" key={itemId}>
                          <p>{item.task}</p>
                          <p className="field-hint">
                            Owner: {item.owner ?? "Not stated"}
                          </p>
                          <p className="field-hint">
                            Extracted deadline: {item.deadline ?? "Not stated"}
                          </p>
                          {reminderId ? (
                            <>
                              <p className="field-hint">Reminder saved</p>
                              <p className="field-hint">
                                Minutes edits do not change this reminder. Open
                                it to change its title or schedule.
                              </p>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => onSelectReminder(reminderId)}
                              >
                                Open saved reminder
                              </Button>
                            </>
                          ) : pendingReminderItemId === itemId ? (
                            <p className="field-hint">Reminder saved</p>
                          ) : confirmation ? (
                            <form
                              onSubmit={confirmReminder}
                              className="result-editor"
                              aria-busy={creatingReminder}
                              noValidate
                            >
                              <fieldset
                                className="result-editor"
                                disabled={creatingReminder}
                              >
                                <legend className="sr-only">
                                  Confirm reminder for action item {index + 1}
                                </legend>
                                <div className="field">
                                  <Label
                                    htmlFor={`${id}-reminder-title-${index}`}
                                  >
                                    Reminder title
                                  </Label>
                                  <Input
                                    id={`${id}-reminder-title-${index}`}
                                    value={confirmation.title}
                                    onChange={(event) =>
                                      setReminderDraft(
                                        (current) =>
                                          current && {
                                            ...current,
                                            title: event.target.value,
                                            error: "",
                                          },
                                      )
                                    }
                                    aria-describedby={`${id}-reminder-title-help-${index}`}
                                    required
                                    autoFocus
                                  />
                                  <p
                                    id={`${id}-reminder-title-help-${index}`}
                                    className="field-hint"
                                  >
                                    Use one line, up to 200 characters. Shorten
                                    a longer task here without changing your
                                    minutes.
                                  </p>
                                </div>
                                <div className="field">
                                  <Label
                                    htmlFor={`${id}-reminder-due-${index}`}
                                  >
                                    Reminder date and time
                                  </Label>
                                  <Input
                                    id={`${id}-reminder-due-${index}`}
                                    type="datetime-local"
                                    value={confirmation.localDue}
                                    onChange={(event) =>
                                      setReminderDraft(
                                        (current) =>
                                          current && {
                                            ...current,
                                            localDue: event.target.value,
                                          },
                                      )
                                    }
                                    aria-describedby={`${id}-reminder-timezone-${index}`}
                                    required
                                  />
                                  <p
                                    id={`${id}-reminder-timezone-${index}`}
                                    className="field-hint"
                                  >
                                    Timezone: {timezone}. Choose an explicit
                                    future date and time. The extracted deadline
                                    is not used to guess a schedule.
                                  </p>
                                </div>
                                {confirmation.error && (
                                  <p className="action-error" role="alert">
                                    {confirmation.error}
                                  </p>
                                )}
                                <div className="quick-view-actions">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    onClick={() => {
                                      if (mutationLock.current) return;
                                      restoreEditFocus.current = true;
                                      setReminderDraft(null);
                                    }}
                                  >
                                    Cancel reminder
                                  </Button>
                                  <Button type="submit">
                                    {creatingReminder
                                      ? "Saving…"
                                      : "Confirm reminder"}
                                  </Button>
                                </div>
                              </fieldset>
                            </form>
                          ) : onCreateReminder ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={creatingReminder}
                              onClick={() => prepareReminder(item, index)}
                            >
                              <CalendarClock aria-hidden="true" /> Create
                              reminder
                            </Button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="field-hint">None stated.</p>
                )}
              </div>
              <div className="field">
                <p className="detail-label">Open questions</p>
                {saved.minutes.open_questions.length ? (
                  <ul className="lookup-sources" aria-label="Open questions">
                    {saved.minutes.open_questions.map((line, index) => (
                      <li key={index}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="field-hint">None stated.</p>
                )}
              </div>
            </div>
            <Collapsible className="source-transcript">
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm">
                  Transcript <ChevronDown aria-hidden="true" />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <p>{saved.transcript}</p>
              </CollapsibleContent>
            </Collapsible>
          </>
        )}
        {error && (
          <p className="action-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="quick-view-footer">
        <p className="quick-view-feedback" role="status">
          {feedback ? (
            <>
              <Check size={14} aria-hidden="true" />
              {feedback}
            </>
          ) : editing ? (
            "Review minutes, then save or cancel."
          ) : saved.sample ? (
            "Sample result"
          ) : (
            "Saved in this browser"
          )}
        </p>
        <div className="quick-view-actions">
          {editing ? (
            <>
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={cancelEdit}
              >
                Cancel
              </Button>
              <Button type="submit" form={editorId} disabled={saving}>
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </>
          ) : (
            <>
              <Button
                ref={editButton}
                type="button"
                variant="outline"
                disabled={creatingReminder}
                onClick={beginEdit}
              >
                <Pencil aria-hidden="true" /> Edit
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  const language = saved.replyLanguage ?? "en";
                  onPlayReply(
                    minutesSpeech(saved.minutes.summary, language),
                    language,
                  );
                }}
              >
                <Volume2 aria-hidden="true" /> Play summary
              </Button>
              <Button type="button" variant="outline" onClick={copy}>
                <Copy aria-hidden="true" /> Copy
              </Button>
              <Button type="button" variant="outline" onClick={download}>
                <Download aria-hidden="true" /> Download
              </Button>
              <Button asChild variant="outline">
                <a
                  href={minutesComposeUrl(saved.minutes)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Email minutes via Gmail, opens in a new tab"
                >
                  <ArrowUpRight aria-hidden="true" /> Email minutes
                </a>
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
