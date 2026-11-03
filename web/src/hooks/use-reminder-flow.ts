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
  updateResult,
  type StoredResult,
} from "@/lib/reminder-store";
import { VoiceCapture, type CapturePhase } from "@/lib/voice-capture";
import type { Captions } from "@/lib/transcript";
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
  speechError: string;
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
  speechError: "",
};

type Pending = { request: CommandRequest; response?: CommandResponse };

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
  const [savedResult, setSavedResult] = useState<StoredResult | null>(null);
  const [execution, reportExecution] =
    useState<ExecutionActivity>(idleExecution);
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
  const speech = useRef<SpeechSynthesisUtterance | null>(null);
  const speechResultIds = useRef<string[]>([]);

  const current = (id: number) => mounted.current && generation.current === id;

  function cancelSpeech() {
    if (!speech.current) return;
    speech.current = null;
    window.speechSynthesis?.cancel();
    if (mounted.current)
      reportExecution((previous) => ({
        ...previous,
        running: false,
        status: "Confirmation stopped",
      }));
  }

  function speak(saved: StoredResult[]) {
    cancelSpeech();
    speechResultIds.current = saved.map((result) => result.id);
    if (
      !("speechSynthesis" in window) ||
      typeof SpeechSynthesisUtterance === "undefined"
    ) {
      setView((previous) => ({
        ...previous,
        speechError:
          "Saved. Spoken confirmation isn't available in this browser.",
      }));
      return;
    }
    try {
      const reminder = saved.find((result) => result.kind === "reminder");
      const draft = saved.find((result) => result.kind === "draft");
      const time = reminder
        ? new Intl.DateTimeFormat("en", {
            timeZone: reminder.timezone,
            weekday: "long",
            month: "long",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short",
          }).format(new Date(reminder.dueAt))
        : "";
      const utterance = new SpeechSynthesisUtterance(
        [
          draft ? "Draft saved." : "",
          reminder ? `${reminder.title}. Reminder saved for ${time}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
      utterance.lang = "en";
      speech.current = utterance;
      utterance.onstart = () => {
        if (mounted.current && speech.current === utterance)
          reportExecution((previous) => ({
            ...previous,
            running: true,
            status: "Speaking confirmation",
            stages: reminder ? ["DIAL"] : ["MAIL"],
          }));
      };
      utterance.onend = () => {
        if (speech.current === utterance) {
          speech.current = null;
          if (mounted.current)
            reportExecution((previous) => ({
              ...previous,
              running: false,
              status: "Confirmation spoken",
            }));
        }
      };
      const failed = () => {
        if (mounted.current && speech.current === utterance) {
          speech.current = null;
          reportExecution((previous) => ({
            ...previous,
            running: false,
            status: "Saved. Spoken confirmation unavailable",
          }));
          setView((previous) => ({
            ...previous,
            speechError: "Saved, but the spoken confirmation couldn't play.",
          }));
        }
      };
      utterance.onerror = failed;
      window.speechSynthesis.speak(utterance);
    } catch {
      speech.current = null;
      reportExecution((previous) => ({
        ...previous,
        running: false,
        status: "Saved. Spoken confirmation unavailable",
      }));
      setView((previous) => ({
        ...previous,
        speechError: "Saved, but the spoken confirmation couldn't play.",
      }));
    }
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
        setView((previous) => ({ ...previous, phase: "ready", status: "" }));
      }
    };
    window.addEventListener("pagehide", release);
    return () => {
      mounted.current = false;
      release();
      window.removeEventListener("pagehide", release);
    };
    // Startup only reads local records. Provider calls happen in click handlers.
  }, []);

  async function savePending(id: number) {
    const command = pending.current;
    if (!command)
      throw new Error("No command is available. Please record again.");
    reportExecution({
      requestId: command.request.command_id,
      stages: command.request.selected_contact_id ? ["MAIL"] : ["ORB"],
      status: command.request.selected_contact_id
        ? "Resolving selected contact"
        : "Interpreting command",
      running: true,
    });
    if (!command.response) {
      setView((previous) => ({ ...previous, phase: "processing", error: "" }));
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
      outcome = await commitCommand(command.request, command.response.actions);
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
    setSavedResult(
      outcome.records.find((result) => result.kind === "draft") ??
        outcome.records[0],
    );
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
    setView((previous) => ({
      ...previous,
      phase: "saved",
      error: "",
      question: "",
      options: [],
      deliveryNotice: hasDraft
        ? "Open the draft to review and send in Gmail."
        : "",
      status: outcome.created
        ? hasDraft && hasReminder
          ? "Draft and reminder saved"
          : hasDraft
            ? "Draft saved"
            : "Reminder saved"
        : "This command is already saved",
      speechError: "",
    }));
    retainedAudio.current = [];
    // commitCommand resolves only from tx.oncomplete. A replay never speaks.
    if (outcome.created) speak(outcome.records);
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
    busy.current = true;
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
    setView((previous) => ({
      ...previous,
      error: "",
      question: "",
      options: [],
      deliveryNotice: "",
      status: "",
      speechError: "",
      retryAt: 0,
    }));
    const session = new VoiceCapture(
      {
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
            "Email delivery isn't available. Morning can save a draft for you to copy.",
        }));
      retainedAudio.current = session.audioComplete ? [...session.audio] : [];
      if (new TextEncoder().encode(transcript).byteLength > 8192)
        throw new Error(
          "This command is too long. Record a shorter, complete reminder command.",
        );
      pending.current = {
        request: {
          command_id: crypto.randomUUID(),
          transcript,
          now: new Date().toISOString(),
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

  function showTranscript(transcript: string) {
    if (busy.current) return;
    setView({ ...readyVoice, captions: { final: transcript, interim: "" } });
    reportExecution(idleExecution);
  }

  function startHold() {
    if (busy.current || loadFailed.current || Date.now() < view.retryAt)
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
    const saved = speechResultIds.current
      .map((id) => records.find((record) => record.id === id))
      .filter((record): record is StoredResult => Boolean(record));
    if (!saved.length) return;
    setView((previous) => ({ ...previous, speechError: "" }));
    speak(saved);
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

  return {
    view,
    execution,
    reportExecution,
    records,
    contacts,
    addContact,
    chooseContact,
    savedResult,
    record,
    retry,
    cancel,
    edit,
    showTranscript,
    retrySpeech,
    cancelSpeech,
    stop,
    startHold,
    releaseHold,
    cancelHold,
    active: [
      "loading",
      "requesting",
      "connecting",
      "listening",
      "finishing",
      "processing",
      "saving",
    ].includes(view.phase),
  };
}
