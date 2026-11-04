import { useEffect, useRef, useState } from "react";
import {
  interpretCommand,
  postJSON,
  withSelectedContact,
  withSelectedReminder,
  withSelectedDraft,
  RequestError,
  type CommandRequest,
  type CommandResponse,
} from "@/lib/command-api";
import {
  addGuestContact,
  addManualReminder,
  commitCommand,
  commitLookup,
  commitMinutes,
  lookupRecord,
  minutesRecord,
  loadWorkspace,
  earlierActivity,
  selectWorkspaceSession,
  deleteWorkspaceSession,
  previousTurnContext,
  storeTurn,
  type Session,
  type Turn,
  updateResult,
  type StoredResult,
  type StoredReminder,
  type StoredDraft,
  type StoredLookup,
  type StoredMinutes,
} from "@/lib/reminder-store";
import {
  continuesLookupContext,
  lookupProgress,
  type LookupContext,
} from "@/lib/lookup-result";
import { VoiceCapture, type CapturePhase } from "@/lib/voice-capture";
import type { Captions } from "@/lib/transcript";
import { confirmationText, SpokenReply } from "@/lib/spoken-reply";
import {
  clarificationTarget,
  speechLanguage,
  type SpeechLanguage,
} from "@/lib/language";
import {
  downloadResult,
  type MeetingMinutes,
  type WorkspaceResult,
} from "@/lib/results";
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
  reminderOptions: StoredReminder[];
  draftOptions: StoredDraft[];
  deliveryNotice: string;
  error: string;
  status: string;
  retryAt: number;
  lookupRetryAt?: number;
  playbackError: string;
  replyAvailable: boolean;
  turnId?: string;
  lookupContext?: LookupContext;
};

export const readyVoice: VoiceView = {
  phase: "ready",
  captions: { final: "", interim: "" },
  question: "",
  options: [],
  reminderOptions: [],
  draftOptions: [],
  deliveryNotice: "",
  error: "",
  status: "",
  retryAt: 0,
  playbackError: "",
  replyAvailable: false,
};

type Pending = {
  turn: Turn;
  turnSaved: boolean;
  request: CommandRequest;
  response?: CommandResponse;
  reminders: StoredReminder[];
  drafts: StoredDraft[];
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
    return "Morning couldn't connect. Check your connection, then retry. Your transcript is still available.";
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
  const selectedSessionRef = useRef("");
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
  const spokenText = useRef("");
  const spokenLanguage = useRef<SpeechLanguage>("en");

  const current = (id: number) => mounted.current && generation.current === id;

  function cancelSpeech() {
    speech.current?.stop();
    speech.current = null;
    spokenText.current = "";
  }

  function speak(text: string, saved = true, language = speechLanguage(text)) {
    cancelSpeech();
    let restoredStatus = "";
    const reply = new SpokenReply(
      text,
      (state, message) => {
        if (!mounted.current || speech.current !== reply) return;
        reportExecution((previous) => {
          if (state === "speaking" && previous.status !== "Speaking") {
            restoredStatus = previous.status;
          }
          return {
            ...previous,
            running: state === "speaking",
            status:
              state === "speaking"
                ? "Speaking"
                : restoredStatus || (saved ? "Saved" : "Replied"),
          };
        });
        setView((previous) => ({
          ...previous,
          playbackError: message ?? "",
        }));
      },
      language,
    );
    speech.current = reply;
    spokenText.current = text;
    spokenLanguage.current = language;
    setView((previous) => ({ ...previous, replyAvailable: true }));
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
      selectedSessionRef.current = stored.selectedSession;
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
      cancelSpeech();
      setSelectedSession(selected);
      selectedSessionRef.current = selected;
    } catch {
      if (mounted.current)
        setSelectionError("Couldn't switch sessions. Try again.");
    } finally {
      selectingRef.current = false;
      if (mounted.current) setSelecting(false);
    }
  }

  async function deleteSession(id: string) {
    if (selectingRef.current || busy.current || id === earlierActivity) return;
    selectingRef.current = true;
    setSelecting(true);
    setSelectionError("");
    try {
      const outcome = await deleteWorkspaceSession(id);
      if (!mounted.current) return;
      setSessions((prev) => {
        const remaining = prev.filter((s) => s.id !== id);
        if (outcome.created) {
          return [...remaining, outcome.created];
        }
        return remaining;
      });
      setTurns((prev) => prev.filter((t) => t.sessionId !== id));
      setRecords((prev) => prev.filter((r) => r.sessionId !== id));
      if (selectedSessionRef.current === id) {
        cancelSpeech();
        setSelectedSession(outcome.selected);
        selectedSessionRef.current = outcome.selected;
      }
    } catch {
      if (mounted.current)
        setSelectionError("Couldn't delete session. Try again.");
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
    const searching =
      !command.response &&
      lookupProgress(
        command.request.transcript,
        command.request.lookup_context,
      );
    reportExecution({
      requestId: command.request.command_id,
      stages: command.request.selected_contact_id ? ["MAIL"] : ["ORB"],
      status: searching
        ? "Searching"
        : command.request.selected_contact_id
          ? "Preparing your draft"
          : "Working",
      running: true,
    });
    setView((previous) => ({
      ...previous,
      turnId: command.turn.id,
      phase: "processing",
      status: searching ? "Searching" : "",
      error: "",
    }));
    if (!command.turnSaved) {
      await storeTurn(command.turn);
      if (mounted.current) setTurns((previous) => [...previous, command.turn]);
      command.turnSaved = true;
      if (!current(id)) return;
    }
    const isMeeting =
      /^\s*(?:(?:please|can you|could you)\s+)?(?:take\s+)?(?:meeting\s+minutes|minutes\s+of\s+(?:the\s+)?meeting|summarize\s+(?:this\s+)?meeting|meeting\s+notes)\b/i.test(
        command.turn.transcript,
      );
    if (isMeeting) {
      reportExecution({
        requestId: command.request.command_id,
        stages: ["PEN"],
        status: "Summarizing meeting",
        running: true,
      });
      setView((previous) => ({
        ...previous,
        turnId: command.turn.id,
        phase: "processing",
        status: "Summarizing meeting",
        error: "",
      }));
      const abort = new AbortController();
      requestAbort.current = abort;
      let minutesData: unknown;
      try {
        minutesData = await postJSON(
          "/api/minutes",
          { transcript: command.turn.transcript },
          abort.signal,
        );
      } catch (err) {
        if (current(id)) showError(err);
        return;
      }
      if (!current(id)) return;
      setView((previous) => ({ ...previous, phase: "saving", error: "" }));
      saving.current = true;
      let outcome: Awaited<ReturnType<typeof commitMinutes>>;
      try {
        outcome = await commitMinutes(
          command.turn,
          minutesData as MeetingMinutes,
        );
      } finally {
        saving.current = false;
      }
      command.turn = outcome.turn;
      if (!current(id)) return;
      setTurns((previous) =>
        previous.map((turn) =>
          turn.id === command.turn.id ? command.turn : turn,
        ),
      );
      reportExecution({
        requestId: command.request.command_id,
        stages: ["PEN"],
        status: "Minutes saved",
        running: false,
      });
      setView((previous) => ({
        ...previous,
        phase: "saved",
        status: outcome.turn.minutes!.summary,
        question: "",
        options: [],
        reminderOptions: [],
        draftOptions: [],
        lookupContext: undefined,
        deliveryNotice: "",
        error: "",
        playbackError: "",
        replyAvailable: true,
      }));
      retainedAudio.current = [];
      if (
        outcome.created &&
        /\b(?:text\s+file|\.txt|download(?:\s+(?:it|a|the))?\s+file)\b/i.test(
          command.turn.transcript,
        )
      ) {
        const record = minutesRecord(command.turn);
        if (record) {
          try {
            downloadResult(record, "txt");
          } catch {}
        }
      }
      if (
        outcome.created &&
        selectedSessionRef.current === command.turn.sessionId
      ) {
        speak(outcome.turn.minutes!.summary, true, "en");
      }
      return;
    }
    if (!command.response) {
      const abort = new AbortController();
      requestAbort.current = abort;
      command.response = await interpretCommand(command.request, abort.signal);
      if (!current(id)) return;
    }
    if (command.response.kind === "lookup") {
      setView((previous) => ({ ...previous, phase: "saving", error: "" }));
      saving.current = true;
      let outcome: Awaited<ReturnType<typeof commitLookup>>;
      try {
        outcome = await commitLookup(command.turn, command.response.result);
      } finally {
        saving.current = false;
      }
      command.turn = outcome.turn;
      if (!current(id)) return;
      setTurns((previous) =>
        previous.map((turn) =>
          turn.id === command.turn.id ? command.turn : turn,
        ),
      );
      reportExecution({
        requestId: command.request.command_id,
        stages: ["ORB"],
        status: "Answer saved",
        running: false,
      });
      setView((previous) => ({
        ...previous,
        phase: "saved",
        status: command.turn.lookup!.answer,
        question: "",
        options: [],
        reminderOptions: [],
        draftOptions: [],
        lookupContext: undefined,
        deliveryNotice: "",
        error: "",
        playbackError: "",
        replyAvailable: true,
      }));
      retainedAudio.current = [];
      if (
        outcome.created &&
        /\b(?:text\s+file|\.txt|download(?:\s+(?:it|a|the))?\s+file)\b/i.test(
          command.turn.transcript,
        )
      ) {
        const record = lookupRecord(command.turn);
        if (record) {
          try {
            downloadResult(record, "txt");
          } catch {}
        }
      }
      // A storage retry reuses command.response. Changing sessions cannot move
      // this snapshot or make a background conversation speak over the current one.
      if (
        outcome.created &&
        selectedSessionRef.current === command.turn.sessionId
      )
        speak(
          command.turn.lookup!.speech,
          true,
          command.turn.lookup!.reply_language,
        );
      return;
    }
    if (command.response.kind === "reply") {
      const text = command.response.text;
      command.turn = {
        ...command.turn,
        reply: text,
        replyLanguage: command.response.replyLanguage,
      };
      await storeTurn(command.turn);
      if (!current(id)) return;
      setTurns((previous) =>
        previous.map((turn) =>
          turn.id === command.turn.id ? command.turn : turn,
        ),
      );
      reportExecution({
        requestId: command.request.command_id,
        stages: ["ORB"],
        status: "Replied",
        running: false,
      });
      setView((previous) => ({
        ...previous,
        phase: "saved",
        status: text,
        question: "",
        options: [],
        reminderOptions: [],
        draftOptions: [],
        playbackError: "",
      }));
      retainedAudio.current = [];
      speak(text, false, command.response.replyLanguage);
      return;
    }
    if (command.response.kind === "clarification") {
      const { question, options, lookupContext } = command.response;
      if (lookupContext) {
        command.turn = {
          ...command.turn,
          reply: question,
          lookupContext,
          replyLanguage: command.response.replyLanguage,
        };
        await storeTurn(command.turn);
        if (!current(id)) return;
        setTurns((previous) =>
          previous.map((turn) =>
            turn.id === command.turn.id ? command.turn : turn,
          ),
        );
      }
      const reminderOptions =
        clarificationTarget(question) === "reminder" ? command.reminders : [];
      const draftOptions =
        clarificationTarget(question) === "draft" ? command.drafts : [];
      reportExecution({
        requestId: command.request.command_id,
        stages: options.length ? ["MAIL"] : ["ORB"],
        status: options.length
          ? "Choose a contact"
          : reminderOptions.length
            ? "Choose a reminder"
            : draftOptions.length
              ? "Choose a draft"
              : "Clarification needed",
        running: false,
      });
      setView((previous) => ({
        ...previous,
        phase: "clarification",
        status: lookupContext ? "Waiting for location" : "",
        question,
        options,
        reminderOptions,
        draftOptions,
        lookupContext,
        error: "",
      }));
      if (
        (lookupContext || command.response.replyLanguage === "hi") &&
        [...question].length <= 240 &&
        selectedSessionRef.current === command.turn.sessionId
      )
        speak(question, false, command.response.replyLanguage);
      return;
    }
    setView((previous) => ({ ...previous, phase: "saving", error: "" }));
    const rescheduling =
      command.response.actions[0]?.type === "reschedule_reminder";
    const updatingDraft = command.response.actions[0]?.type === "update_draft";
    const stages: ExecutionActivity["stages"] = command.response.actions.map(
      (action) =>
        action.type === "draft_email"
          ? "MAIL"
          : action.type === "reschedule_reminder" ||
              action.type === "update_draft"
            ? "PEN"
            : "DIAL",
    );
    reportExecution({
      requestId: command.request.command_id,
      stages,
      status: rescheduling
        ? "Updating reminder"
        : updatingDraft
          ? "Updating draft"
          : stages.length === 2
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
        : rescheduling
          ? "Reminder updated"
          : updatingDraft
            ? "Draft updated"
            : hasDraft && hasReminder
              ? "Draft and reminder saved together"
              : hasDraft
                ? "Draft saved"
                : "Reminder saved",
      running: false,
    });
    const confirmation = outcome.created
      ? confirmationText(
          outcome.records,
          rescheduling
            ? "reschedule_reminder"
            : updatingDraft
              ? "update_draft"
              : undefined,
          command.response.replyLanguage,
        )
      : "This command is already saved";
    setView((previous) => ({
      ...previous,
      phase: "saved",
      error: "",
      question: "",
      options: [],
      reminderOptions: [],
      draftOptions: [],
      deliveryNotice: hasDraft
        ? "Open the draft to review and send in Gmail."
        : "",
      status: confirmation,
      playbackError: "",
    }));
    retainedAudio.current = [];
    // commitCommand resolves only from tx.oncomplete. A replay never speaks.
    if (outcome.created)
      speak(confirmation, true, command.response.replyLanguage);
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
      ...(error instanceof RequestError && error.lookupOnly
        ? { retryAt: 0, lookupRetryAt: error.retryAt }
        : { lookupRetryAt: 0 }),
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
    const latestTurn = turns
      .filter((turn) => turn.sessionId === sessionId)
      .at(-1);
    const lookupContext =
      pending.current?.turn.sessionId === sessionId &&
      pending.current.response?.kind === "clarification"
        ? pending.current.response.lookupContext
        : latestTurn?.lookupContext;
    const reminders = records
      .filter(
        (record): record is StoredReminder =>
          record.kind === "reminder" && record.sessionId === sessionId,
      )
      .map((record) => ({ ...record }));
    const drafts = records
      .filter(
        (record): record is StoredDraft =>
          record.kind === "draft" && record.sessionId === sessionId,
      )
      .map((record) => ({ ...record }));
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
      const activeLookup = continuesLookupContext(transcript, lookupContext)
        ? lookupContext
        : undefined;
      if (lookupContext && !activeLookup && latestTurn?.lookupContext) {
        const cleared = { ...latestTurn };
        delete cleared.lookupContext;
        delete cleared.reply;
        await storeTurn(cleared);
        if (mounted.current)
          setTurns((previous) =>
            previous.map((item) => (item.id === cleared.id ? cleared : item)),
          );
        if (!current(id)) return;
      }
      const turn = {
        id: crypto.randomUUID(),
        sessionId,
        transcript,
        createdAt: new Date().toISOString(),
      };
      const previous_turn = previousTurnContext(turns, sessionId);
      pending.current = {
        turn,
        turnSaved: false,
        reminders,
        drafts,
        request: activeLookup
          ? {
              command_id: turn.id,
              transcript,
              now: turn.createdAt,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              lookup_context: activeLookup,
            }
          : {
              command_id: turn.id,
              transcript,
              now: turn.createdAt,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              contacts: relevantContacts(contacts, transcript),
              ...(previous_turn ? { previous_turn } : {}),
              ...(reminders.length === 1
                ? {
                    reminder_context: {
                      id: reminders[0].id,
                      due_at: reminders[0].dueAt,
                    },
                  }
                : {}),
              ...(drafts.length === 1
                ? {
                    draft_context: {
                      id: drafts[0].id,
                      subject: drafts[0].subject,
                      body: drafts[0].body,
                      recipient: drafts[0].recipient,
                      to: drafts[0].to,
                    },
                  }
                : {}),
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
    if (
      busy.current ||
      Date.now() < Math.max(view.retryAt, view.lookupRetryAt ?? 0)
    )
      return;
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

  async function cancel() {
    if (saving.current || view.phase === "saving" || view.phase === "loading")
      return;
    cancelSpeech();
    generation.current++;
    capture.current?.cancel();
    capture.current = null;
    captureOwner.current = null;
    requestAbort.current?.abort();
    busy.current = false;
    pending.current = null;
    reportExecution({ ...idleExecution, status: "Request cancelled" });
    setView((previous) => ({
      ...previous,
      phase: "ready",
      error: "",
      question: "",
      options: [],
      reminderOptions: [],
      draftOptions: [],
      lookupContext: undefined,
      status: "",
    }));
    const latest = turns
      .filter((turn) => turn.sessionId === selectedSession)
      .at(-1);
    if (latest?.lookupContext) {
      busy.current = true;
      saving.current = true;
      setView((previous) => ({ ...previous, phase: "saving" }));
      const cancelled = { ...latest };
      delete cancelled.lookupContext;
      delete cancelled.reply;
      try {
        await storeTurn(cancelled);
        if (mounted.current)
          setTurns((previous) =>
            previous.map((turn) =>
              turn.id === cancelled.id ? cancelled : turn,
            ),
          );
        if (mounted.current)
          setView((previous) => ({ ...previous, phase: "ready" }));
      } catch (error) {
        if (mounted.current) showError(error);
      } finally {
        saving.current = false;
        busy.current = false;
      }
    }
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
    setView((previous) => ({ ...previous, playbackError: "" }));
    const latest = turns
      .filter((turn) => turn.sessionId === selectedSession)
      .at(-1);
    const text = latest?.lookup?.speech ?? latest?.reply;
    const language =
      latest?.lookup?.reply_language ??
      latest?.replyLanguage ??
      speechLanguage(text ?? "");
    if (
      speech.current &&
      (!text ||
        (text === spokenText.current && language === spokenLanguage.current))
    )
      speech.current.play();
    else if (text) speak(text, !latest?.lookupContext, language);
    else speech.current?.play();
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

  async function chooseReminder(reminderId: string) {
    if (busy.current || Date.now() < view.retryAt) return;
    const command = pending.current;
    if (
      !command ||
      command.response?.kind !== "clarification" ||
      clarificationTarget(command.response.question) !== "reminder"
    )
      return;
    try {
      command.request = withSelectedReminder(
        command.request,
        command.reminders,
        reminderId,
      );
    } catch (error) {
      showError(error);
      return;
    }
    command.response = undefined;
    await retry();
  }

  async function chooseDraft(draftId: string) {
    if (busy.current || Date.now() < view.retryAt) return;
    const command = pending.current;
    if (
      !command ||
      command.response?.kind !== "clarification" ||
      clarificationTarget(command.response.question) !== "draft"
    )
      return;
    try {
      command.request = withSelectedDraft(
        command.request,
        command.drafts,
        draftId,
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
          status: latest.reply ?? "",
          lookupContext: latest.lookupContext,
          phase: latest.lookupContext
            ? ("clarification" as const)
            : visibleView.phase,
          question: latest.lookupContext
            ? (latest.reply ?? "Which city or landmark?")
            : "",
          replyAvailable: Boolean(latest.lookup || latest.reply),
        }
      : visibleView,
    orbCore,
    execution: ownCommand ? execution : idleExecution,
    records: selectedRecords,
    results: [
      ...selectedRecords,
      ...sessionTurns.flatMap((turn) => {
        const record = lookupRecord(turn);
        const minutes = minutesRecord(turn);
        const items: (StoredLookup | StoredMinutes)[] = [];
        if (record) items.push(record);
        if (minutes) items.push(minutes);
        return items;
      }),
    ],
    sessions,
    turns,
    sessionTurns,
    hasLegacy: legacyTurns.size > 0,
    selectedSession,
    selectSession,
    deleteSession,
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
    chooseReminder,
    chooseDraft,
    record,
    retry,
    cancel,
    edit,
    retrySpeech,
    playReply: (text: string, language = speechLanguage(text)) => {
      if (
        speech.current &&
        spokenText.current === text &&
        spokenLanguage.current === language
      )
        speech.current.play();
      else speak(text, true, language);
    },
    stop,
    startHold,
    releaseHold,
    cancelHold,
    summarizeMeeting: async (meetingTranscript: string): Promise<string> => {
      const transcript = meetingTranscript.trim();
      if (!transcript) {
        throw new Error("Provide meeting notes or a transcript to summarize.");
      }
      const sessionId = selectedSessionRef.current;
      if (!sessionId || sessionId === earlierActivity) {
        throw new Error("Please select an active session to save minutes.");
      }
      const turn: Turn = {
        id: crypto.randomUUID(),
        sessionId,
        transcript,
        createdAt: new Date().toISOString(),
      };
      await storeTurn(turn);
      if (mounted.current) setTurns((previous) => [...previous, turn]);
      const abort = new AbortController();
      const data = await postJSON(
        "/api/minutes",
        { transcript },
        abort.signal,
      );
      const outcome = await commitMinutes(turn, data as MeetingMinutes);
      if (mounted.current) {
        setTurns((previous) =>
          previous.map((item) => (item.id === turn.id ? outcome.turn : item)),
        );
      }
      return `minutes:${turn.id}`;
    },
    createReminder: async (
      title: string,
      dueAt: string,
    ): Promise<StoredReminder> => {
      const sessionId = selectedSessionRef.current;
      if (!sessionId || sessionId === earlierActivity) {
        throw new Error("Please select an active session to save a reminder.");
      }
      const reminder = await addManualReminder(title, dueAt, sessionId);
      if (mounted.current) {
        setRecords((previous) => [reminder, ...previous]);
      }
      return reminder;
    },
  };
}
