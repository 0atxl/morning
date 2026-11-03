import { useEffect, useRef, useState } from "react";
import {
  interpretCommand,
  withSelectedContact,
  RequestError,
  type CommandRequest,
  type CommandResponse,
} from "@/lib/command-api";
import {
  addGuestContact,
  commitCommand,
  loadWorkspace,
  earlierActivity,
  selectWorkspaceSession,
  storeTurn,
  type Session,
  type Turn,
  updateResult,
  type StoredResult,
} from "@/lib/reminder-store";
import { VoiceCapture, type CapturePhase } from "@/lib/voice-capture";
import type { Captions } from "@/lib/transcript";
import { confirmationText, SpokenReply } from "@/lib/spoken-reply";
import type { WorkspaceResult } from "@/lib/results";
import { idleExecution, type ExecutionActivity } from "@/lib/execution";
import {
  relevantContacts,
  type ContactOption,
  type GuestContact,
} from "@/lib/contacts";

export type VoicePhase =
  | CapturePhase
  | "loading"
  | "ready"
  | "processing"
  | "saving"
  | "saved"
  | "clarification"
  | "error";
export type VoiceView = {
  phase: VoicePhase;
  captions: Captions;
  question: string;
  options: ContactOption[];
  deliveryNotice: string;
  error: string;
  status: string;
  retryAt: number;
  playReply: boolean;
  turnId?: string;
};

export const readyVoice: VoiceView = {
  phase: "ready",
  captions: { final: "", interim: "" },
  question: "",
  options: [],
  deliveryNotice: "",
  error: "",
  status: "",
  retryAt: 0,
  playReply: false,
};

type Pending = {
  turn: Turn;
  turnSaved: boolean;
  request: CommandRequest;
  response?: CommandResponse;
};

function errorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === "NotAllowedError")
    return "Microphone access was denied. Allow the microphone in your browser, then retry.";
  if (error instanceof DOMException && error.name === "NotFoundError")
    return "No microphone was found. Connect a microphone, then retry.";
  if (error instanceof DOMException && error.name === "NotReadableError")
    return "The microphone couldn't be opened. Close other apps using it, then retry.";
  if (error instanceof DOMException && error.name === "TimeoutError")
    return "Morning's request timed out. Your transcript is still available. Please retry.";
  if (error instanceof TypeError)
    return "Morning couldn't connect. Check your connection and that the Go server is running, then retry.";
  return error instanceof Error
    ? error.message
    : "Morning couldn't finish. Your transcript is still available. Please retry.";
}

export function useReminderFlow() {
  const [view, setView] = useState<VoiceView>({
    ...readyVoice,
    phase: "loading",
  });
  const [records, setRecords] = useState<StoredResult[]>([]);
  const [contacts, setContacts] = useState<GuestContact[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [selectedSession, setSelectedSession] = useState("");
  const [commandSession, setCommandSession] = useState("");
  const [selecting, setSelecting] = useState(false);
  const selectingRef = useRef(false);
  const [selectionError, setSelectionError] = useState("");
  const [execution, reportExecution] =
    useState<ExecutionActivity>(idleExecution);
  const orbCore = useRef<HTMLSpanElement>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const busy = useRef(false);
  const saving = useRef(false);
  const capture = useRef<VoiceCapture | null>(null);
  const captureOwner = useRef<"pointer" | "hold" | null>(null);
  const retainedAudio = useRef<Blob[]>([]);
  const pending = useRef<Pending | null>(null);
  const requestAbort = useRef<AbortController | null>(null);
  const loadFailed = useRef(false);
  const speech = useRef<SpokenReply | null>(null);

  const current = (id: number) => mounted.current && generation.current === id;

  function cancelSpeech() {
    speech.current?.stop();
    speech.current = null;
  }

  function speak(text: string) {
    cancelSpeech();
    const reply = new SpokenReply(text, (state) => {
      if (!mounted.current || speech.current !== reply) return;
      reportExecution((previous) => ({
        ...previous,
        running: state === "speaking",
        status: state === "speaking" ? "Speaking" : "Saved",
      }));
      setView((previous) => ({
        ...previous,
        playReply: state === "blocked",
      }));
    });
    speech.current = reply;
    void reply.start();
  }

  async function load() {
    if (busy.current) return;
    busy.current = true;
    const id = ++generation.current;
    setView((previous) => ({ ...previous, phase: "loading", error: "" }));
    try {
      const stored = await loadWorkspace();
      if (!current(id)) return;
      setRecords(stored.records);
      setSessions(stored.sessions);
      setTurns(stored.turns);
      setSelectedSession(stored.selectedSession);
      setContacts(stored.contacts);
      loadFailed.current = false;
      setView((previous) => ({ ...previous, phase: "ready", error: "" }));
    } catch (error) {
      if (!current(id)) return;
      loadFailed.current = true;
      setView((previous) => ({
        ...previous,
        phase: "error",
        error: errorMessage(error),
      }));
    } finally {
      if (current(id)) busy.current = false;
    }
  }

  async function selectSession(id?: string) {
    if (selectingRef.current || id === selectedSession) return;
    selectingRef.current = true;
    setSelecting(true);
    setSelectionError("");
    try {
      const { selected, created } = await selectWorkspaceSession(id);
      if (!mounted.current) return;
      if (created) setSessions((previous) => [...previous, created]);
      setSelectedSession(selected);
    } catch {
      if (mounted.current)
        setSelectionError("Couldn't switch sessions. Try again.");
    } finally {
      selectingRef.current = false;
      if (mounted.current) setSelecting(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void load();
    const release = () => {
      generation.current++;
      capture.current?.cancel();
      requestAbort.current?.abort();
      cancelSpeech();
      busy.current = false;
      capture.current = null;
      captureOwner.current = null;
      if (mounted.current) {
        reportExecution(idleExecution);
        setView(readyVoice);
      }
    };
    window.addEventListener("pagehide", release);
    return () => {
      mounted.current = false;
      release();
      window.removeEventListener("pagehide", release);
    };
    // Startup opens local storage. Audio starts only from user actions or a new save.
  }, []);

  async function savePending(id: number) {
    const command = pending.current;
    if (!command)
      throw new Error("No command is available. Please record again.");
    reportExecution({
      requestId: command.request.command_id,
      stages: command.request.selected_contact_id ? ["MAIL"] : ["ORB"],
      status: command.request.selected_contact_id
        ? "Preparing your draft"
        : "Working",
      running: true,
    });
    setView((previous) => ({
      ...previous,
      turnId: command.turn.id,
      phase: "processing",
      error: "",
    }));
    if (!command.turnSaved) {
      await storeTurn(command.turn);
      if (mounted.current) setTurns((previous) => [...previous, command.turn]);
      command.turnSaved = true;
      if (!current(id)) return;
    }
    if (!command.response) {
      const abort = new AbortController();
      requestAbort.current = abort;
      command.response = await interpretCommand(command.request, abort.signal);
      if (!current(id)) return;
    }
    if (command.response.kind === "clarification") {
      const { question, options } = command.response;
      reportExecution({
        requestId: command.request.command_id,
        stages: options.length ? ["MAIL"] : ["ORB"],
        status: options.length ? "Choose a contact" : "Clarification needed",
        running: false,
      });
      setView((previous) => ({
        ...previous,
        phase: "clarification",
        question,
        options,
        error: "",
      }));
      return;
    }
    setView((previous) => ({ ...previous, phase: "saving", error: "" }));
    const stages: ExecutionActivity["stages"] = command.response.actions.map(
      (action) => (action.type === "draft_email" ? "MAIL" : "DIAL"),
    );
    reportExecution({
      requestId: command.request.command_id,
      stages,
      status:
        stages.length === 2
          ? "Saving draft and reminder together"
          : stages[0] === "MAIL"
            ? "Saving draft"
            : "Saving reminder",
      running: true,
    });
    saving.current = true;
    let outcome: Awaited<ReturnType<typeof commitCommand>>;
    try {
      outcome = await commitCommand(
        command.request,
        command.response.actions,
        command.turn.sessionId,
      );
    } finally {
      saving.current = false;
    }
    if (!current(id)) return;
    setRecords((previous) => [
      ...outcome.records,
      ...previous.filter(
        (record) => !outcome.records.some((saved) => saved.id === record.id),
      ),
    ]);
    const hasDraft = outcome.records.some((result) => result.kind === "draft");
    const hasReminder = outcome.records.some(
      (result) => result.kind === "reminder",
    );
    reportExecution({
      requestId: command.request.command_id,
      stages,
      status: !outcome.created
        ? "Command already saved"
        : hasDraft && hasReminder
          ? "Draft and reminder saved together"
          : hasDraft
            ? "Draft saved"
            : "Reminder saved",
      running: false,
    });
    const confirmation = outcome.created
      ? confirmationText(outcome.records)
      : "This command is already saved";
    setView((previous) => ({
      ...previous,
      phase: "saved",
      error: "",
      question: "",
      options: [],
      deliveryNotice: hasDraft
        ? "Open the draft to review and send in Gmail."
        : "",
      status: confirmation,
      playReply: false,
    }));
    retainedAudio.current = [];
    // commitCommand resolves only from tx.oncomplete. A replay never speaks.
    if (outcome.created) speak(confirmation);
  }

  function showError(error: unknown) {
    reportExecution((previous) => ({
      ...previous,
      running: false,
      status: "Request failed. Transcript retained",
    }));
    setView((previous) => ({
      ...previous,
      phase: "error",
      error: errorMessage(error),
      retryAt: error instanceof RequestError ? error.retryAt : 0,
    }));
  }

  async function record(
    replay?: readonly Blob[],
    owner: "pointer" | "hold" = "pointer",
  ) {
    if (busy.current) return;
    if (loadFailed.current) {
      await load();
      return;
    }
    const sessionId = selectedSession;
    if (!sessionId || sessionId === earlierActivity || selectingRef.current)
      return;
    setCommandSession(sessionId);
    busy.current = true;
    orbCore.current?.style.removeProperty("--level");
    captureOwner.current = owner;
    const id = ++generation.current;
    cancelSpeech();
    pending.current = null;
    reportExecution({
      ...idleExecution,
      stages: ["STT"],
      status: "Starting transcription",
      running: true,
    });
    setView({ ...readyVoice, phase: replay ? "connecting" : "requesting" });
    const session = new VoiceCapture(
      {
        level: (level) => {
          if (current(id))
            orbCore.current?.style.setProperty("--level", level.toFixed(3));
        },
        phase: (phase) => {
          if (current(id)) {
            setView((previous) => ({ ...previous, phase }));
            reportExecution({
              requestId: null,
              stages: ["STT"],
              status:
                phase === "requesting"
                  ? "Requesting microphone access"
                  : phase === "connecting"
                    ? "Connecting transcription"
                    : phase === "listening"
                      ? "Listening"
                      : "Finalizing transcript",
              running: true,
            });
          }
        },
        captions: (captions) => {
          if (current(id)) setView((previous) => ({ ...previous, captions }));
        },
      },
      replay,
    );
    capture.current = session;
    try {
      const transcript = await session.run();
      if (!current(id)) return;
      if (/\b(send|deliver)\b/i.test(transcript))
        setView((previous) => ({
          ...previous,
          deliveryNotice:
            "Morning can prepare a draft for you to send in Gmail.",
        }));
      retainedAudio.current = session.audioComplete ? [...session.audio] : [];
      if (new TextEncoder().encode(transcript).byteLength > 8192)
        throw new Error(
          "This command is too long. Record a shorter, complete reminder command.",
        );
      const turn = {
        id: crypto.randomUUID(),
        sessionId,
        transcript,
        createdAt: new Date().toISOString(),
      };
      pending.current = {
        turn,
        turnSaved: false,
        request: {
          command_id: turn.id,
          transcript,
          now: turn.createdAt,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          contacts: relevantContacts(contacts, transcript),
        },
      };
      await savePending(id);
    } catch (error) {
      if (!current(id)) return;
      retainedAudio.current = session.audioComplete ? [...session.audio] : [];
      showError(error);
    } finally {
      if (current(id)) {
        busy.current = false;
        capture.current = null;
        captureOwner.current = null;
      }
    }
  }

  async function retry() {
    if (busy.current || Date.now() < view.retryAt) return;
    if (loadFailed.current) {
      await load();
      return;
    }
    if (!pending.current) {
      await record(
        retainedAudio.current.length ? [...retainedAudio.current] : undefined,
      );
      return;
    }
    busy.current = true;
    const id = ++generation.current;
    try {
      await savePending(id);
    } catch (error) {
      if (current(id)) showError(error);
    } finally {
      if (current(id)) busy.current = false;
    }
  }

  function cancel() {
    if (saving.current || view.phase === "saving" || view.phase === "loading")
      return;
    generation.current++;
    capture.current?.cancel();
    capture.current = null;
    captureOwner.current = null;
    requestAbort.current?.abort();
    busy.current = false;
    reportExecution({ ...idleExecution, status: "Request cancelled" });
    setView((previous) => ({
      ...previous,
      phase: "ready",
      error: "",
      question: "",
      options: [],
      status: "",
    }));
  }

  async function edit(result: WorkspaceResult) {
    const updated = await updateResult(result);
    if (mounted.current)
      setRecords((previous) =>
        previous.map((record) => (record.id === updated.id ? updated : record)),
      );
  }

  function startHold() {
    if (
      busy.current ||
      loadFailed.current ||
      selectingRef.current ||
      selectedSession === earlierActivity ||
      (commandSession === selectedSession && Date.now() < view.retryAt)
    )
      return false;
    void record(undefined, "hold");
    return true;
  }

  function stop() {
    captureOwner.current = null;
    capture.current?.stop();
  }

  function releaseHold() {
    if (captureOwner.current !== "hold") return;
    if (capture.current?.isRecording) stop();
    else cancel(); // Permission or socket startup has no completed audio to send.
  }

  function cancelHold() {
    if (captureOwner.current === "hold") cancel();
  }

  function retrySpeech() {
    setView((previous) => ({ ...previous, playReply: false }));
    speech.current?.play();
  }

  async function chooseContact(contactId: string) {
    if (busy.current || Date.now() < view.retryAt) return;
    const command = pending.current;
    if (!command || command.response?.kind !== "clarification") return;
    try {
      command.request = withSelectedContact(
        command.request,
        command.response.options,
        contactId,
      );
    } catch (error) {
      showError(error);
      return;
    }
    command.response = undefined;
    await retry();
  }

  async function addContact(name: string, email: string) {
    const saved = await addGuestContact(name, email);
    if (mounted.current)
      setContacts((previous) =>
        [...previous.filter((contact) => contact.id !== saved.id), saved].sort(
          (a, b) => a.name.localeCompare(b.name),
        ),
      );
    return saved;
  }

  const ownCommand = !commandSession || selectedSession === commandSession;
  const active = [
    "loading",
    "requesting",
    "connecting",
    "listening",
    "finishing",
    "processing",
    "saving",
  ].includes(view.phase);
  const selectedRecords = records.filter(
    (record) => (record.sessionId ?? earlierActivity) === selectedSession,
  );
  const legacyTurns = new Map<string, Turn>();
  for (const record of records) {
    if (record.sessionId || legacyTurns.has(record.commandId)) continue;
    legacyTurns.set(record.commandId, {
      id: record.commandId,
      sessionId: earlierActivity,
      createdAt: record.createdAt,
      transcript: record.transcript,
    });
  }
  const sessionTurns =
    selectedSession === earlierActivity
      ? [...legacyTurns.values()].reverse()
      : turns.filter((turn) => turn.sessionId === selectedSession);
  const visibleView = ownCommand ? view : readyVoice;
  const latest = sessionTurns.at(-1);
  const showLatest =
    visibleView.phase === "ready" && !visibleView.captions.final && latest;

  return {
    view: showLatest
      ? {
          ...visibleView,
          turnId: latest.id,
          captions: { final: latest.transcript, interim: "" },
        }
      : visibleView,
    orbCore,
    execution: ownCommand ? execution : idleExecution,
    records: selectedRecords,
    sessions,
    turns,
    sessionTurns,
    hasLegacy: legacyTurns.size > 0,
    selectedSession,
    selectSession,
    selectionError,
    canSelect:
      Boolean(selectedSession) &&
      !selecting &&
      !["requesting", "connecting", "listening"].includes(view.phase),
    recorderUnavailable:
      selecting ||
      selectedSession === earlierActivity ||
      (!ownCommand && active),
    contacts,
    addContact,
    chooseContact,
    record,
    retry,
    cancel,
    edit,
    retrySpeech,
    stop,
    startHold,
    releaseHold,
    cancelHold,
  };
}
