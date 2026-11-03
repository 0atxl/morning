import { useEffect, useRef, useState } from "react";
import {
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import { ResultQuickView } from "@/components/result-quick-view";
import { ContactsDialog } from "@/components/contacts-dialog";
import { ExecutionActivityView } from "@/components/execution-activity";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { idleExecution, type ExecutionActivity } from "@/lib/execution";
import { VoiceCommand } from "@/components/voice-command";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import { previewStates, type PreviewState } from "@/fixtures/workspace";
import { useDesignPreview } from "@/fixtures/use-design-preview";
import { useReminderFlow } from "@/hooks/use-reminder-flow";
import { useRecorderShortcut } from "@/hooks/use-recorder-shortcut";
import { canToggleRecorder } from "@/lib/recorder-shortcut";
import { formatDue, type WorkspaceResult } from "@/lib/results";

export function App() {
  const live = useReminderFlow();
  const design = useDesignPreview();
  const isPreview = design.scene !== null;
  const view = isPreview ? design.view : live.view;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panel, setPanel] = useState<"preview" | "contacts" | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const openedRequest = useRef<string | null>(null);
  const previewHold = useRef(false);
  const [lastEdited, setLastEdited] = useState<string | null>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const micButton = useRef<HTMLButtonElement | null>(null);
  const contactsButton = useRef<HTMLButtonElement | null>(null);
  const visibleResults: WorkspaceResult[] = isPreview
    ? design.results
    : live.records;
  const selected =
    visibleResults.find((result) => result.id === selectedId) ?? null;
  const historyRows = [
    ...new Map(
      visibleResults.map(
        (result) =>
          [
            "commandId" in result ? result.commandId : result.id,
            result,
          ] as const,
      ),
    ).values(),
  ];

  useEffect(() => {
    if (!live.savedResult) return;
    returnFocus.current = micButton.current;
    setSelectedId(live.savedResult.id);
  }, [live.savedResult]);

  function preview(next: PreviewState | null) {
    if (live.active) return;
    live.cancelSpeech();
    setSelectedId(null);
    setLastEdited(null);
    setPanel(null);
    previewHold.current = false;
    design.select(next);
  }

  function toggleCapture() {
    if (!canToggleRecorder(view.phase, view.retryAt)) return;
    previewHold.current = false;
    if (isPreview) design.toggle();
    else if (live.view.phase === "listening") live.stop();
    else void live.record();
  }

  useRecorderShortcut(
    () => {
      if (!isPreview) return live.startHold();
      previewHold.current = true;
      design.start();
      return true;
    },
    () => {
      if (!isPreview) live.releaseHold();
      else if (previewHold.current) {
        previewHold.current = false;
        design.finish();
      }
    },
    () => {
      if (!isPreview) live.cancelHold();
      else if (previewHold.current) {
        previewHold.current = false;
        design.select("ready");
      }
    },
    () =>
      panel === null &&
      selectedId === null &&
      view.phase !== "listening" &&
      canToggleRecorder(view.phase, view.retryAt),
  );

  const execution: ExecutionActivity = isPreview
    ? {
        ...idleExecution,
        stages:
          view.phase === "listening"
            ? ["STT"]
            : view.phase === "saved"
              ? ["DIAL"]
              : ["ORB"],
        running: ["listening", "processing"].includes(view.phase),
        status:
          view.phase === "listening"
            ? "Listening"
            : view.phase === "processing"
              ? "Interpreting sample command"
              : view.phase === "saved"
                ? "Reminder saved"
                : view.phase === "error"
                  ? "Request failed"
                  : view.phase === "clarification"
                    ? "Clarification needed"
                    : "Ready",
      }
    : live.execution;

  useEffect(() => {
    const requestId = live.execution.requestId;
    if (isPreview || !requestId || openedRequest.current === requestId) return;
    openedRequest.current = requestId;
    setActivityOpen(true);
    // Opening a layout panel never moves focus. A manual close persists for
    // this request, including retries and further action/speech events.
  }, [isPreview, live.execution.requestId]);

  async function saveResult(updated: WorkspaceResult) {
    if (isPreview) design.save(updated);
    else await live.edit(updated);
    setLastEdited(updated.title);
  }

  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={500}>
      <div className="workspace-shell">
        <a className="skip-link" href="#workspace">
          Skip to workspace
        </a>
        <header className="workspace-toolbar">
          <Button
            variant="ghost"
            className="toolbar-control"
            aria-expanded={historyOpen}
            aria-controls="history-panel"
            onClick={() => setHistoryOpen((open) => !open)}
          >
            History
            <ChevronDown />
          </Button>

          <span className="wordmark" aria-label="Morning guest workspace">
            Morning
          </span>

          <Button
            variant="ghost"
            className="toolbar-control activity-control"
            aria-expanded={activityOpen}
            aria-controls="activity-panel"
            onClick={() => setActivityOpen((open) => !open)}
          >
            Activity
            <ChevronDown />
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
                  {historyRows.length ? (
                    <ul className="history-list">
                      {historyRows.map((result) => (
                        <li key={result.id}>
                          <Button
                            variant="ghost"
                            className="history-command"
                            disabled={!isPreview && live.active}
                            onClick={() => {
                              if (isPreview)
                                design.showTranscript(result.transcript);
                              else live.showTranscript(result.transcript);
                            }}
                          >
                            {result.transcript}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="panel-empty">No commands yet.</p>
                  )}
                </aside>
              </CollapsibleContent>
            </div>
          </Collapsible>
          <main id="workspace" className="workspace-main" tabIndex={-1}>
            <VoiceCommand
              view={view}
              preview={isPreview}
              primaryRef={micButton}
              onToggle={toggleCapture}
              onRetry={() => {
                if (isPreview) design.retry();
                else void live.retry();
              }}
              onCancel={live.cancel}
              onRetrySpeech={live.retrySpeech}
              onChooseContact={(id) => {
                void live.chooseContact(id);
              }}
              onOpenContacts={() => setPanel("contacts")}
            />

            <section
              className="results-section"
              aria-labelledby="results-heading"
            >
              <h2 id="results-heading" className="sr-only">
                Saved results
              </h2>
              {visibleResults.length ? (
                <ul className="result-list">
                  {visibleResults.map((result) => (
                    <li key={result.id}>
                      <Button
                        variant="outline"
                        className="result-row"
                        aria-haspopup="dialog"
                        disabled={!isPreview && live.active}
                        onClick={(event) => {
                          returnFocus.current = event.currentTarget;
                          setSelectedId(result.id);
                        }}
                      >
                        {result.kind === "draft" ? (
                          <FileText
                            className="result-icon"
                            aria-hidden="true"
                          />
                        ) : (
                          <CalendarClock
                            className="result-icon"
                            aria-hidden="true"
                          />
                        )}
                        <span className="result-name">{result.title}</span>
                        {result.kind === "reminder" ? (
                          <time
                            className="result-time"
                            dateTime={result.dueAt}
                            title={formatDue(result, true)}
                          >
                            {formatDue(result)}
                          </time>
                        ) : null}
                        <ChevronRight
                          className="result-chevron"
                          aria-hidden="true"
                        />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="results-empty">No saved results yet.</p>
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
                  {activityOpen ? (
                    <ExecutionActivityView
                      execution={execution}
                      preview={isPreview}
                      results={visibleResults}
                      lastEdited={lastEdited}
                    />
                  ) : null}
                </aside>
              </CollapsibleContent>
            </div>
          </Collapsible>
        </div>

        <footer className="workspace-footer">
          {!isPreview ? (
            <Button
              ref={contactsButton}
              variant="ghost"
              size="sm"
              className="preview-trigger"
              disabled={live.active}
              onClick={() => setPanel("contacts")}
            >
              <Users />
              Contacts
            </Button>
          ) : null}
          <Popover
            open={panel === "preview"}
            onOpenChange={(open) => setPanel(open ? "preview" : null)}
          >
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="preview-trigger"
                disabled={live.active}
              >
                <SlidersHorizontal />
                Design preview
                <ChevronDown />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="preview-popover"
              align="start"
              side="top"
              sideOffset={10}
              collisionPadding={16}
              aria-label="Design preview states"
            >
              <h2 className="popover-heading">Design preview</h2>
              <p className="preview-description">
                Sample states use no microphone or providers. Preview edits
                reset on reload.
              </p>
              <div className="preview-options" aria-label="Preview state">
                <Button
                  variant="ghost"
                  className="preview-option"
                  aria-pressed={!isPreview}
                  onClick={() => preview(null)}
                >
                  <span>Guest workspace</span>
                  {!isPreview ? <Check aria-hidden="true" /> : null}
                </Button>
                {previewStates.map((state) => (
                  <Button
                    key={state.value}
                    variant="ghost"
                    className="preview-option"
                    aria-pressed={design.scene === state.value}
                    onClick={() => preview(state.value)}
                  >
                    <span>{state.label}</span>
                    {design.scene === state.value ? (
                      <Check aria-hidden="true" />
                    ) : null}
                  </Button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <span className="fixture-notice">
            {isPreview ? "Sample data" : "Guest workspace"}
          </span>
        </footer>
      </div>

      <ResultQuickView
        result={selected}
        results={visibleResults}
        onSelect={setSelectedId}
        onSave={saveResult}
        onRestoreFocus={() => returnFocus.current?.focus()}
      />
      <ContactsDialog
        open={panel === "contacts" && !isPreview}
        contacts={live.contacts}
        pendingClarification={live.view.phase === "clarification"}
        onOpenChange={(open) => setPanel(open ? "contacts" : null)}
        onAdd={live.addContact}
        onRestoreFocus={() => contactsButton.current?.focus()}
      />
    </TooltipProvider>
  );
}
