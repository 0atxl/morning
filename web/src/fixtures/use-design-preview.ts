import { useEffect, useState } from "react";
import { readyVoice, type VoiceView } from "@/hooks/use-reminder-flow";
import type { WorkspaceResult } from "@/lib/results";
import {
  initialResults,
  SAMPLE_COMMAND,
  SAMPLE_CLARIFICATION_COMMAND,
  SAMPLE_QUESTION,
  SAMPLE_ERROR,
  SAMPLE_REMINDER,
  type PreviewState,
} from "./workspace";

const words = SAMPLE_COMMAND.split(" ");

export function useDesignPreview() {
  const [scene, setScene] = useState<PreviewState | null>(null);
  const [results, setResults] = useState(initialResults);
  const [wordCount, setWordCount] = useState(3);
  const [playing, setPlaying] = useState(false);
  const [history, setHistory] = useState<string | null>(null);

  function addReminder() {
    setResults((previous) =>
      previous.some((result) => result.id === SAMPLE_REMINDER.id)
        ? previous
        : [{ ...SAMPLE_REMINDER }, ...previous],
    );
  }

  useEffect(() => {
    if (scene !== "listening") return;
    const interval = window.setInterval(
      () => setWordCount((count) => Math.min(count + 1, words.length)),
      380,
    );
    return () => window.clearInterval(interval);
  }, [scene]);

  useEffect(() => {
    if (scene !== "processing" || !playing) return;
    const timeout = window.setTimeout(() => {
      setResults((previous) =>
        previous.some((result) => result.id === SAMPLE_REMINDER.id)
          ? previous
          : [{ ...SAMPLE_REMINDER }, ...previous],
      );
      setScene("saved");
      setPlaying(false);
    }, 650);
    return () => window.clearTimeout(timeout);
  }, [scene, playing]);

  function select(next: PreviewState | null) {
    setHistory(null);
    setPlaying(false);
    setScene(next);
    setWordCount(3);
    if (next === "saved") addReminder();
  }

  function toggle() {
    setHistory(null);
    setPlaying(true);
    if (scene !== "listening") setWordCount(3);
    setScene(scene === "listening" ? "processing" : "listening");
  }

  const ready = !scene || scene === "ready" || scene === "empty";
  const view: VoiceView = {
    ...readyVoice,
    phase: scene === "empty" || scene === null ? "ready" : scene,
    captions:
      scene === "listening"
        ? {
            final: words.slice(0, Math.max(0, wordCount - 2)).join(" "),
            interim: words
              .slice(Math.max(0, wordCount - 2), wordCount)
              .join(" "),
          }
        : {
            final:
              history ??
              (ready
                ? ""
                : scene === "clarification"
                  ? SAMPLE_CLARIFICATION_COMMAND
                  : SAMPLE_COMMAND),
            interim: "",
          },
    question: scene === "clarification" ? SAMPLE_QUESTION : "",
    error: scene === "error" ? SAMPLE_ERROR : "",
    status: scene === "saved" ? "Reminder saved in preview" : "",
  };

  return {
    scene,
    view,
    select,
    toggle,
    start: () => {
      setHistory(null);
      setPlaying(true);
      setWordCount(3);
      setScene("listening");
    },
    finish: () => {
      setHistory(null);
      setPlaying(true);
      setScene("processing");
    },
    results: scene === "empty" ? [] : results,
    retry: () => {
      setPlaying(true);
      setScene("processing");
    },
    save: (updated: WorkspaceResult) =>
      setResults((previous) =>
        previous.map((result) => (result.id === updated.id ? updated : result)),
      ),
    showTranscript: (text: string) => {
      setPlaying(false);
      setHistory(text);
      setScene("ready");
    },
  };
}
