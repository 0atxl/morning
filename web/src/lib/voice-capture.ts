import { micLevelMeter } from "./mic-level.ts";
import { object, voiceToken } from "./command-api.ts";
import { TranscriptBuffer, type Captions } from "./transcript.ts";

export type CapturePhase =
  "requesting" | "connecting" | "listening" | "finishing";
type Callbacks = {
  level: (level: number) => void;
  phase: (phase: CapturePhase) => void;
  captions: (captions: Captions) => void;
};
export type CaptureOptions = {
  autoStopOnSilence?: boolean;
  silenceMs?: number;
};

// One instance owns one recording or an explicit replay of its retained audio.
// No provider request is made by constructing or importing this class.
export class VoiceCapture {
  readonly audio: Blob[] = [];
  audioComplete = false;
  private readonly abort = new AbortController();
  private readonly transcript = new TranscriptBuffer();
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private meter?: ReturnType<typeof micLevelMeter>;
  private recorder: MediaRecorder | null = null;
  private recorderStopped: Promise<void> = Promise.resolve();
  private resolve: (transcript: string) => void = () => {};
  private reject: (error: Error) => void = () => {};
  private ended = false;
  private stopping = false;
  private closeSent = false;
  private metadata = false;
  private keepAlive = 0;
  private watchdog = 0;
  private silenceCheck = 0;
  private heardSpeech = false;
  private lastSpeechAt = 0;
  private lastTranscriptText = "";
  private started = false;

  constructor(
    private readonly callbacks: Callbacks,
    private readonly replay?: readonly Blob[],
    private readonly options: CaptureOptions = {},
  ) {}

  run(): Promise<string> {
    if (this.started)
      return Promise.reject(new Error("This recording has already started."));
    this.started = true;
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      void this.open().catch((error: unknown) => this.fail(error));
    });
  }

  private async open() {
    if (!this.replay) {
      this.callbacks.phase("requesting");
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      ) {
        throw new Error(
          "Microphone recording isn't available. Use a supported browser on HTTPS or localhost.",
        );
      }
      try {
        this.meter = micLevelMeter((level) => {
          this.callbacks.level(level);
          if (level > 0.08) {
            this.heardSpeech = true;
            this.lastSpeechAt = Date.now();
          } else if (this.heardSpeech && level > 0.05) {
            this.lastSpeechAt = Date.now();
          }
        });
      } catch {
        // Metering is optional on browsers that only support MediaRecorder.
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (this.ended) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/mp4",
      ].find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType)
        throw new Error(
          "This browser can't record a supported audio format. Please use Chrome, Edge, Firefox or Safari.",
        );
      const recorder = new MediaRecorder(stream, { mimeType });
      this.recorder = recorder;
      this.recorderStopped = new Promise((resolve) => {
        recorder.onstop = () => {
          this.audioComplete = true;
          resolve();
          this.releaseMicrophone();
          if (this.ended) return;
          if (this.stopping) this.closeStream();
          else
            void this.fail(
              new Error(
                "Microphone capture stopped unexpectedly. Your words and audio are available for Retry.",
              ),
            );
        };
      });
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        this.audio.push(event.data);
        if (!this.ended) this.sendAudio(event.data);
      };
      recorder.onerror = () => {
        void this.fail(new Error("Microphone capture failed. Please retry."));
      };
      stream.getAudioTracks().forEach((track) =>
        track.addEventListener("ended", () => {
          if (this.stream && !this.stopping && !this.ended)
            void this.fail(new Error("Microphone access ended. Please retry."));
        }),
      );
    } else {
      this.audio.push(...this.replay);
      this.audioComplete = true;
    }

    this.callbacks.phase("connecting");
    const grant = await voiceToken(this.abort.signal);
    if (this.ended) return;
    const socket = new WebSocket(grant.url, ["bearer", grant.token]);
    this.socket = socket;
    this.watchdog = window.setTimeout(() => {
      void this.fail(
        new Error("The voice connection timed out. Please retry."),
      );
    }, 10_000);
    socket.onopen = () => {
      if (this.ended) {
        socket.close();
        return;
      }
      window.clearTimeout(this.watchdog);
      this.keepAlive = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN && !this.closeSent) {
          try {
            socket.send(JSON.stringify({ type: "KeepAlive" }));
          } catch (error) {
            void this.fail(error);
          }
        }
      }, 4000);
      try {
        if (this.replay) {
          this.callbacks.phase("finishing");
          for (const chunk of this.replay) this.sendAudio(chunk);
          this.closeStream();
        } else {
          this.recorder!.start(250);
          try {
            this.meter?.listen(this.stream!);
          } catch {
            this.meter?.close();
            this.meter = undefined;
          }
          this.callbacks.captions({ final: "", interim: "" });
          this.callbacks.phase("listening");
          if (this.options.autoStopOnSilence) {
            const silenceMs = this.options.silenceMs ?? 2200;
            this.lastSpeechAt = Date.now();
            this.silenceCheck = window.setInterval(() => {
              if (
                this.isRecording &&
                this.heardSpeech &&
                Date.now() - this.lastSpeechAt >= silenceMs
              ) {
                this.stop();
              }
            }, 250);
          }
        }
      } catch (error) {
        void this.fail(error);
      }
    };
    socket.onmessage = (event: MessageEvent) => {
      if (this.ended) return;
      try {
        if (typeof event.data !== "string")
          throw new Error(
            "Morning received an unreadable voice response. Please retry.",
          );
        const data: unknown = JSON.parse(event.data);
        const message = object(data);
        if (message?.type === "Results") {
          const next = this.transcript.accept(data);
          const combined = [next.final, next.interim]
            .filter(Boolean)
            .join(" ")
            .trim();
          if (combined && combined !== this.lastTranscriptText) {
            this.lastTranscriptText = combined;
            this.heardSpeech = true;
            this.lastSpeechAt = Date.now();
          }
          this.callbacks.captions(next);
        } else if (message?.type === "Metadata" && this.closeSent)
          this.metadata = true;
        else if (message?.type === "Error")
          throw new Error(
            "The transcription service couldn't finish. Please retry.",
          );
      } catch (error) {
        void this.fail(error);
      }
    };
    socket.onerror = () => {
      void this.fail(
        new Error(
          "The voice connection failed. Your captured words are still available. Please retry.",
        ),
      );
    };
    socket.onclose = (event) => {
      if (this.ended) return;
      if (
        !this.closeSent ||
        !this.metadata ||
        !event.wasClean ||
        event.code !== 1000
      ) {
        void this.fail(
          new Error(
            "The voice connection ended before transcription finished. Please retry.",
          ),
        );
        return;
      }
      const captions = this.transcript.captions();
      const transcriptText = [captions.final.trim(), captions.interim.trim()]
        .filter(Boolean)
        .join(" ");
      if (!transcriptText) {
        void this.fail(
          new Error(
            "No speech was transcribed. Please speak or type your command.",
          ),
        );
        return;
      }
      this.ended = true;
      this.clearTimers();
      this.releaseMicrophone();
      this.resolve(transcriptText);
    };
  }

  stop() {
    if (
      this.ended ||
      this.stopping ||
      !this.recorder ||
      this.recorder.state === "inactive"
    )
      return;
    this.stopping = true;
    this.callbacks.phase("finishing");
    this.watchdog = window.setTimeout(() => {
      void this.fail(
        new Error("Finishing the recording timed out. Please retry."),
      );
    }, 20_000);
    try {
      // stop's final dataavailable is delivered before onstop. Blob sends are
      // synchronous and ordered, so CloseStream follows the very last chunk.
      this.recorder.requestData();
      this.recorder.stop();
    } catch (error) {
      void this.fail(error);
    }
  }

  get isRecording() {
    return (
      !this.ended && !this.stopping && this.recorder?.state === "recording"
    );
  }

  cancel() {
    void this.fail(new DOMException("Recording cancelled.", "AbortError"));
  }

  private sendAudio(chunk: Blob) {
    if (this.ended) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      void this.fail(
        new Error(
          "The voice connection was lost. Please retry the captured audio.",
        ),
      );
      return;
    }
    if (this.socket.bufferedAmount > 8 * 1024 * 1024) {
      void this.fail(
        new Error(
          "The voice connection couldn't keep up. Your audio is available for Retry.",
        ),
      );
      return;
    }
    try {
      this.socket.send(chunk);
    } catch (error) {
      void this.fail(error);
    }
  }

  private closeStream() {
    if (this.ended || this.closeSent) return;
    if (this.socket?.readyState !== WebSocket.OPEN) {
      void this.fail(
        new Error(
          "The voice connection ended before the final audio arrived. Please retry.",
        ),
      );
      return;
    }
    this.closeSent = true;
    window.clearTimeout(this.watchdog);
    window.clearInterval(this.keepAlive);
    this.watchdog = window.setTimeout(() => {
      void this.fail(new Error("Final transcription timed out. Please retry."));
    }, 15_000);
    try {
      this.socket.send(JSON.stringify({ type: "CloseStream" }));
    } catch (error) {
      void this.fail(error);
    }
  }

  private async fail(reason: unknown) {
    if (this.ended) return;
    this.ended = true;
    this.abort.abort();
    this.clearTimers();
    try {
      this.socket?.close();
    } catch {
      /* The connection may already be gone. */
    }
    if (this.recorder) {
      try {
        if (this.recorder.state !== "inactive") {
          this.recorder.stop();
          // Retain the final chunk only when a recorder actually started.
          await new Promise<void>((resolve) => {
            const timeout = window.setTimeout(resolve, 1000);
            void this.recorderStopped.then(() => {
              window.clearTimeout(timeout);
              resolve();
            });
          });
        }
      } catch {
        /* Still release tracks and retain any chunks already delivered. */
      }
    }
    this.releaseMicrophone();
    const error =
      reason instanceof Error
        ? reason
        : new Error("Recording failed. Please retry.");
    this.reject(error);
  }

  private releaseMicrophone() {
    this.meter?.close();
    this.meter = undefined;
    const stream = this.stream;
    this.stream = null;
    stream?.getTracks().forEach((track) => track.stop());
  }

  private clearTimers() {
    window.clearTimeout(this.watchdog);
    window.clearInterval(this.keepAlive);
    window.clearInterval(this.silenceCheck);
  }
}
