import type { WorkspaceResult } from "./results.ts";
import { speechLanguage, type SpeechLanguage } from "./language.ts";

export function confirmationText(
  results: readonly WorkspaceResult[],
  operation?: "reschedule_reminder" | "update_draft",
  language: SpeechLanguage = "en",
) {
  const draft = results.some((result) => result.kind === "draft");
  const reminder = results.find((result) => result.kind === "reminder");
  if (!reminder && language === "hi")
    return operation === "update_draft"
      ? "ईमेल ड्राफ्ट अपडेट हो गया।"
      : "ईमेल ड्राफ्ट सेव हो गया।";
  if (!reminder)
    return operation === "update_draft" ? "Draft updated." : "Draft saved.";
  const time = new Intl.DateTimeFormat(language === "hi" ? "hi-IN" : "en", {
    timeZone: reminder.timezone,
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(reminder.dueAt));
  if (language === "hi")
    return `${draft ? "ईमेल ड्राफ्ट सेव हो गया। " : ""}${time} के लिए रिमाइंडर ${operation === "reschedule_reminder" ? "अपडेट" : "सेव"} हो गया।`;
  return `${draft ? "Draft saved. " : ""}Reminder ${operation === "reschedule_reminder" ? "updated" : "saved"} for ${time}.`;
}

type PlaybackState = "speaking" | "finished" | "blocked";
type PlaybackReport = (state: PlaybackState, message?: string) => void;

async function speechRequestError(response: Response) {
  const status = response.headers.get("X-Morning-Speech-Provider-Status");
  if (response.headers.get("content-type")?.includes("application/json")) {
    const body = await response.json().catch(() => null);
    switch (body?.error?.code) {
      case "speech_plan_required":
        return "Morning's server voice requires a paid ElevenLabs plan.";
      case "speech_not_configured":
        return "Morning's server voice isn't configured.";
      case "speech_provider_invalid_response":
        return "The voice provider returned unusable audio.";
      case "speech_provider_timeout":
        return "The voice provider timed out.";
      case "speech_provider_unavailable":
        if (!status)
          return "Morning couldn't get audio from the voice provider.";
    }
  }
  if (status && /^[1-5]\d\d$/.test(status))
    return `ElevenLabs returned HTTP ${status}.`;
  return `The speech request returned HTTP ${response.status}.`;
}

// One committed command owns its fetch, audio and browser utterance. Keeping
// the MP3 after a blocked attempt lets a click call play() during the gesture.
export class SpokenReply {
  private attempt = 0;
  private readonly abort = new AbortController();
  private clip: Blob | null = null;
  private release?: () => void;
  private audioError = "";

  private readonly text: string;
  private readonly report: PlaybackReport;
  private readonly language: SpeechLanguage;

  constructor(
    text: string,
    report: PlaybackReport,
    language = speechLanguage(text),
  ) {
    this.text = text;
    this.report = report;
    this.language = language;
  }

  async start(browserError?: string) {
    const attempt = ++this.attempt;
    try {
      const response = await fetch("/api/speech", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "audio/mpeg, application/json;q=0.9",
        },
        body: JSON.stringify({
          text: this.text,
          ...(this.language === "hi" ? { language: "hi" } : {}),
        }),
        signal: AbortSignal.any([
          this.abort.signal,
          AbortSignal.timeout(12_000),
        ]),
      });
      if (!response.ok) {
        this.audioError = await speechRequestError(response);
      } else if (
        response.headers
          .get("content-type")
          ?.split(";")[0]
          .trim()
          .toLowerCase() === "audio/mpeg"
      ) {
        const blob = await response.blob();
        if (blob.size && !this.abort.signal.aborted) this.clip = blob;
        else this.audioError = "Morning returned an empty MP3.";
      } else {
        this.audioError = "Morning didn't return an MP3.";
      }
    } catch {
      this.audioError = "The speech request didn't finish.";
    }
    if (this.abort.signal.aborted || attempt !== this.attempt) return;
    if (this.clip) this.playClip(browserError);
    else if (browserError) this.blocked(browserError);
    else this.browserVoice();
  }

  // The click can unlock either a cached clip or the native voice. If there's
  // no clip and that voice fails again, retry only the speech request.
  play() {
    this.attempt++;
    this.release?.();
    if (this.abort.signal.aborted) return;
    if (this.clip) this.playClip();
    else this.browserVoice((reason) => void this.start(reason));
  }

  private blocked(browserError: string) {
    this.report("blocked", `${this.audioError} ${browserError}`);
  }

  private playClip(browserError?: string) {
    if (!this.clip) return;
    const fallback = () =>
      browserError ? this.blocked(browserError) : this.browserVoice();
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
      const failed = (reason: string) => {
        if (this.release !== cleanup) return;
        this.audioError = reason;
        cleanup();
        if (started) this.report("blocked", reason);
        else fallback();
      };
      const timer = window.setTimeout(
        () => failed("MP3 playback didn't start."),
        5000,
      );
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
        const code = audio.error?.code;
        this.clip = null;
        failed(
          code
            ? `MP3 playback failed (media error ${code}).`
            : "MP3 playback failed.",
        );
      };
      audio.src = url;
      void audio.play().catch((error: unknown) => {
        if (this.release !== cleanup) return;
        if (error instanceof DOMException && error.name === "NotSupportedError")
          this.clip = null;
        failed(
          error instanceof DOMException && error.name === "NotAllowedError"
            ? "The browser blocked MP3 playback."
            : "The browser couldn't play the MP3.",
        );
      });
    } catch {
      this.release?.();
      this.clip = null;
      this.audioError = "The browser couldn't open the MP3.";
      fallback();
    }
  }

  private browserVoice(failed = (reason: string) => this.blocked(reason)) {
    const synth = window.speechSynthesis;
    if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
      failed("This browser has no speech synthesizer.");
      return;
    }
    try {
      const utterance = new SpeechSynthesisUtterance(this.text);
      utterance.lang = this.language === "hi" ? "hi-IN" : "en";
      const voice = synth
        .getVoices?.()
        .find(
          (voice) => voice.lang.toLowerCase().split("-")[0] === this.language,
        );
      if (voice) utterance.voice = voice;
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
        failed("The browser voice didn't start.");
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
      utterance.onerror = (event) => {
        clear();
        failed(`Browser speech failed (${event.error}).`);
      };
      synth.speak(utterance);
    } catch {
      this.release?.();
      failed("The browser couldn't start its voice.");
    }
  }

  stop() {
    this.abort.abort();
    this.release?.();
    this.clip = null;
  }
}
