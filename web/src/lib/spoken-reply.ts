import type { WorkspaceResult } from "./results.ts";

export function confirmationText(results: readonly WorkspaceResult[]) {
  const draft = results.some((result) => result.kind === "draft");
  const reminder = results.find((result) => result.kind === "reminder");
  if (!reminder) return "Draft saved.";
  const time = new Intl.DateTimeFormat("en", {
    timeZone: reminder.timezone,
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(reminder.dueAt));
  return `${draft ? "Draft saved. " : ""}Reminder saved for ${time}.`;
}

type PlaybackState = "speaking" | "finished" | "blocked";

// One committed command owns its fetch, audio and browser utterance. Keeping
// the MP3 after a blocked attempt lets a click call play() during the gesture.
export class SpokenReply {
  private readonly abort = new AbortController();
  private clip: Blob | null = null;
  private release?: () => void;

  private readonly text: string;
  private readonly report: (state: PlaybackState) => void;

  constructor(text: string, report: (state: PlaybackState) => void) {
    this.text = text;
    this.report = report;
  }

  async start() {
    try {
      const response = await fetch("/api/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text: this.text }),
        signal: AbortSignal.any([
          this.abort.signal,
          AbortSignal.timeout(12_000),
        ]),
      });
      if (
        response.ok &&
        response.headers.get("content-type")?.startsWith("audio/mpeg")
      ) {
        const blob = await response.blob();
        if (blob.size && !this.abort.signal.aborted) this.clip = blob;
      }
    } catch {
      // The browser can still read the committed reply if the provider fails.
    }
    if (!this.abort.signal.aborted) this.play();
  }

  play() {
    this.release?.();
    if (this.abort.signal.aborted) return;
    if (!this.clip) return this.browserVoice();
    try {
      const audio = new Audio();
      const url = URL.createObjectURL(this.clip);
      let started = false;
      const cleanup = () => {
        window.clearTimeout(timer);
        audio.onplaying = audio.onended = audio.onerror = null;
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        URL.revokeObjectURL(url);
        this.release = undefined;
      };
      const failed = () => {
        if (this.release !== cleanup) return;
        cleanup();
        if (started) this.report("blocked");
        else this.browserVoice();
      };
      const timer = window.setTimeout(failed, 5000);
      this.release = cleanup;
      audio.onplaying = () => {
        window.clearTimeout(timer);
        started = true;
        this.report("speaking");
      };
      audio.onended = () => {
        cleanup();
        this.report("finished");
      };
      audio.onerror = () => {
        this.clip = null;
        failed();
      };
      audio.src = url;
      void audio.play().catch((error: unknown) => {
        if (this.release !== cleanup) return;
        if (error instanceof DOMException && error.name === "NotSupportedError")
          this.clip = null;
        failed();
      });
    } catch {
      this.release?.();
      this.clip = null;
      this.browserVoice();
    }
  }

  private browserVoice() {
    const synth = window.speechSynthesis;
    if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
      this.report("blocked");
      return;
    }
    try {
      const utterance = new SpeechSynthesisUtterance(this.text);
      utterance.lang = "en";
      const clear = () => {
        window.clearTimeout(timer);
        utterance.onstart = utterance.onend = utterance.onerror = null;
        this.release = undefined;
      };
      const cancel = () => {
        clear();
        synth.cancel();
      };
      // Some browsers silently queue a gesture-blocked utterance.
      const timer = window.setTimeout(() => {
        cancel();
        this.report("blocked");
      }, 5000);
      this.release = cancel;
      utterance.onstart = () => {
        window.clearTimeout(timer);
        this.report("speaking");
      };
      utterance.onend = () => {
        clear();
        this.report("finished");
      };
      utterance.onerror = () => {
        clear();
        this.report("blocked");
      };
      synth.speak(utterance);
    } catch {
      this.release?.();
      this.report("blocked");
    }
  }

  stop() {
    this.abort.abort();
    this.release?.();
    this.clip = null;
  }
}
