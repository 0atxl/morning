import { useEffect, useRef, useState } from "react";
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  FileText,
  Plus,
  Users,
  Search,
  Sun,
  Trash2,
} from "lucide-react";
import { ReminderAlerts } from "@/components/reminder-alerts";
import { ResultQuickView } from "@/components/result-quick-view";
import { ContactsDialog } from "@/components/contacts-dialog";
import { MeetingMinutesDialog } from "@/components/minutes-dialog";
import { ExecutionActivityView } from "@/components/execution-activity";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { VoiceCommand } from "@/components/voice-command";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useReminderFlow } from "@/hooks/use-reminder-flow";
import { useRecorderShortcut } from "@/hooks/use-recorder-shortcut";
import { canToggleRecorder } from "@/lib/recorder-shortcut";
import { earlierActivity, type StoredResult } from "@/lib/reminder-store";
import type { StoredLookup } from "@/lib/reminder-store";
import { formatDue, type WorkspaceResult } from "@/lib/results";

function ResultRow({
  result,
  onOpen,
}: {
  result: WorkspaceResult;
  onOpen: (trigger: HTMLButtonElement) => void;
}) {
  const Icon =
    result.kind === "lookup"
      ? result.lookup.kind === "briefing"
        ? Sun
        : Search
      : result.kind === "draft"
        ? FileText
        : result.kind === "minutes"
          ? ClipboardList
          : CalendarClock;
  return (
    <li>
      <Button
        variant="outline"
        className="result-row"
        aria-haspopup="dialog"
        onClick={(event) => onOpen(event.currentTarget)}
      >
        <Icon className="result-icon" aria-hidden="true" />
        <span className="result-name">{result.title}</span>
        {result.kind === "lookup" && (
          <span className="result-time">
            {result.lookup.sources.length}{" "}
            {result.lookup.sources.length === 1 ? "source" : "sources"}
          </span>
        )}
        {result.kind === "minutes" && (
          <span className="result-time">
            {result.minutes.action_items.length}{" "}
            {result.minutes.action_items.length === 1 ? "task" : "tasks"}
          </span>
        )}
        {result.kind === "reminder" && (
          <span className="result-time" style={{ display: "inline-flex", gap: "0.35rem", alignItems: "center" }}>
            {result.repeat && (
              <span className="result-badge" style={{ textTransform: "capitalize", fontSize: "0.75rem" }}>
                {result.repeat}
              </span>
            )}
            <time dateTime={result.dueAt} title={formatDue(result, true)}>
              {formatDue(result)}
            </time>
          </span>
        )}
        <ChevronRight className="result-chevron" aria-hidden="true" />
      </Button>
    </li>
  );
}

export function App() {
  const live = useReminderFlow();
  const { view, selectedSession } = live;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [minutesOpen, setMinutesOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const openedRequest = useRef<string | null>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const contactsButton = useRef<HTMLButtonElement | null>(null);
  const selected =
    live.results.find((result) => result.id === selectedId) ?? null;
  const canRecord = () =>
    !live.recorderUnavailable && canToggleRecorder(view.phase, view.retryAt);

  function toggleCapture() {
    if (!canRecord()) return;
    if (view.phase === "listening") live.stop();
    else void live.record();
  }

  useRecorderShortcut(
    live.startHold,
    live.releaseHold,
    live.cancelHold,
    () =>
      !contactsOpen && !selected && view.phase !== "listening" && canRecord(),
  );

  useEffect(() => {
    const id = live.execution.requestId;
    if (!id || openedRequest.current === id) return;
    openedRequest.current = id;
    setActivityOpen(true);
  }, [live.execution.requestId]);

  const sessionNames = new Map<string, string>();
  for (const turn of live.turns) {
    if (!sessionNames.has(turn.sessionId))
      sessionNames.set(turn.sessionId, turn.transcript);
  }
  const sessions = live.sessions
    .map((session, index) => ({
      id: session.id,
      label: `Session ${index + 1}`,
      excerpt: sessionNames.get(session.id),
    }))
    .reverse();
  if (live.hasLegacy)
    sessions.push({
      id: earlierActivity,
      label: "Earlier activity",
      excerpt: undefined,
    });
  const sessionLabel = sessions.find(
    (session) => session.id === selectedSession,
  )?.label;

  const resultsByTurn = new Map<string, WorkspaceResult[]>();
  for (const result of live.results) {
    const group = resultsByTurn.get(result.commandId) ?? [];
    group.push(result);
    resultsByTurn.set(result.commandId, group);
  }

  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={500}>
      <div className="workspace-shell">
        <a className="skip-link" href="#workspace">
          Skip to workspace
        </a>
        <header className="workspace-toolbar">
          <div className="history-controls">
            <Button
              variant="ghost"
              className="toolbar-control"
              aria-expanded={historyOpen}
              aria-controls="history-panel"
              onClick={() => setHistoryOpen((open) => !open)}
            >
              History <ChevronDown />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="new-session"
              title="New session"
              disabled={!live.canSelect}
              onClick={() => void live.selectSession()}
            >
              <Plus aria-hidden="true" />
              <span>New session</span>
            </Button>
          </div>
          <span className="wordmark">Morning</span>
          <Button
            variant="ghost"
            className="toolbar-control activity-control"
            aria-expanded={activityOpen}
            aria-controls="activity-panel"
            onClick={() => setActivityOpen((open) => !open)}
          >
            Activity <ChevronDown />
          </Button>
        </header>

        <div
          className="workspace-layout"
          data-history-open={historyOpen}
          data-activity-open={activityOpen}
        >
          <Collapsible open={historyOpen} asChild>
            <div className="layout-panel-slot history-slot">
              <CollapsibleContent asChild>
                <aside
                  id="history-panel"
                  className="layout-panel history-panel"
                  aria-labelledby="history-heading"
                >
                  <h2 id="history-heading" className="panel-heading">
                    History
                  </h2>
                  <ul className="history-list">
                    {sessions.map((session) => (
                      <li key={session.id} className="history-item">
                        <Button
                          variant="ghost"
                          className="history-command"
                          aria-current={
                            session.id === selectedSession ? "true" : undefined
                          }
                          disabled={!live.canSelect}
                          title={session.excerpt ?? session.label}
                          onClick={() => void live.selectSession(session.id)}
                        >
                          <span>{session.label}</span>
                          {session.excerpt && <small>{session.excerpt}</small>}
                        </Button>
                        {session.id !== earlierActivity && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="history-delete-button"
                            aria-label={`Delete ${session.label}`}
                            title={`Delete ${session.label}`}
                            disabled={!live.canSelect}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (
                                window.confirm(
                                  `Delete ${session.label} and its saved results from this browser?`,
                                )
                              ) {
                                void live.deleteSession(session.id);
                              }
                            }}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </aside>
              </CollapsibleContent>
            </div>
          </Collapsible>
          <main id="workspace" className="workspace-main" tabIndex={-1}>
            <ReminderAlerts />
            {live.selectionError && <p role="alert">{live.selectionError}</p>}
            <VoiceCommand
              orbCore={live.orbCore}
              view={view}
              disabled={live.recorderUnavailable}
              archive={selectedSession === earlierActivity}
              onToggle={toggleCapture}
              onRetry={() => void live.retry()}
              onCancel={live.cancel}
              onRetrySpeech={live.retrySpeech}
              onChooseContact={(id) => void live.chooseContact(id)}
              onChooseReminder={(id) => void live.chooseReminder(id)}
              onChooseDraft={(id) => void live.chooseDraft(id)}
              onOpenContacts={() => setContactsOpen(true)}
            />

            <section
              className="results-section"
              aria-label={`Conversation: ${sessionLabel ?? "Morning"}`}
            >
              {[...live.sessionTurns].reverse().map((turn) => {
                const results = resultsByTurn.get(turn.id) ?? [];
                return (
                  <div className="conversation-turn" key={turn.id}>
                    {turn.id !== view.turnId && (
                      <p className="past-transcript">{turn.transcript}</p>
                    )}
                    {turn.id !== view.turnId && turn.reply && (
                      <p className="past-reply">
                        <span className="sr-only">Morning: </span>
                        {turn.reply}
                      </p>
                    )}
                    {results.length > 0 && (
                      <ul className="result-list">
                        {results.map((result) => (
                          <ResultRow
                            key={result.id}
                            result={result}
                            onOpen={(trigger) => {
                              returnFocus.current = trigger;
                              setSelectedId(result.id);
                            }}
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
              {!live.results.length && (
                <p className="results-empty">
                  No saved results in this session.
                </p>
              )}
            </section>
          </main>
          <Collapsible open={activityOpen} asChild>
            <div className="layout-panel-slot activity-slot">
              <CollapsibleContent asChild>
                <aside
                  id="activity-panel"
                  className="layout-panel activity-panel"
                  aria-labelledby="activity-heading"
                >
                  <h2 id="activity-heading" className="panel-heading">
                    Activity
                  </h2>
                  <ExecutionActivityView execution={live.execution} />
                </aside>
              </CollapsibleContent>
            </div>
          </Collapsible>
        </div>

        <footer className="workspace-footer">
          <Button
            ref={contactsButton}
            variant="ghost"
            size="sm"
            className="contacts-trigger"
            onClick={() => setContactsOpen(true)}
          >
            <Users /> Contacts
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="contacts-trigger"
            onClick={() => setMinutesOpen(true)}
          >
            <ClipboardList /> Meeting Minutes
          </Button>
        </footer>
      </div>
      <ResultQuickView
        result={selected}
        results={live.results}
        onSelect={setSelectedId}
        onSave={live.edit}
        onPlayReply={live.playReply}
        onCreateReminder={live.createReminder}
        onRestoreFocus={() => returnFocus.current?.focus()}
      />
      <ContactsDialog
        open={contactsOpen}
        contacts={live.contacts}
        pendingClarification={view.phase === "clarification"}
        onOpenChange={setContactsOpen}
        onAdd={live.addContact}
        onRestoreFocus={() => contactsButton.current?.focus()}
      />
      <MeetingMinutesDialog
        open={minutesOpen}
        onOpenChange={setMinutesOpen}
        onSummarize={live.summarizeMeeting}
        onSelectResult={(id) => setSelectedId(id)}
        onRestoreFocus={() => contactsButton.current?.focus()}
      />
    </TooltipProvider>
  );
}
