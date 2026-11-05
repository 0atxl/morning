import { object, postJSON, RequestError } from "./command-api.ts";
import type { SpeechLanguage } from "./language.ts";
import type { MeetingMinutes } from "./results.ts";

export const maxMinutesBody = 64 * 1024;
export const maxMinutesItems = 20;

function text(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    [...value].length <= limit &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
  );
}

export function parseMeetingMinutes(data: unknown): MeetingMinutes {
  const value = object(data);
  const invalid = () =>
    new RequestError(
      "The minutes contain missing or invalid fields. Nothing was saved. Use single-line text within the displayed limits, then retry.",
    );
  if (!value || Object.keys(value).length !== 4 || !text(value.summary, 800))
    throw invalid();
  for (const key of ["decisions", "action_items", "open_questions"] as const) {
    if (!Array.isArray(value[key]) || value[key].length > maxMinutesItems)
      throw invalid();
  }
  const lines = (section: unknown[]): string[] =>
    section.map((line) => {
      if (!text(line, 500)) throw invalid();
      return line;
    });
  const action_items = (value.action_items as unknown[]).map((entry) => {
    const item = object(entry);
    if (
      !item ||
      Object.keys(item).length !== 3 ||
      !text(item.task, 500) ||
      !(item.owner === null || text(item.owner, 200)) ||
      !(item.deadline === null || text(item.deadline, 200))
    )
      throw invalid();
    return { task: item.task, owner: item.owner, deadline: item.deadline };
  });
  return {
    summary: value.summary,
    decisions: lines(value.decisions as unknown[]),
    action_items,
    open_questions: lines(value.open_questions as unknown[]),
  };
}

export function minutesRequest(transcript: string, language: SpeechLanguage) {
  if (!transcript.trim())
    throw new Error("Provide meeting notes or a completed transcript.");
  if (language !== "en" && language !== "hi")
    throw new Error("Choose English or Hindi for the minutes.");
  const body = { transcript, language };
  if (
    new TextEncoder().encode(JSON.stringify(body)).byteLength > maxMinutesBody
  ) {
    throw new Error(
      "These notes exceed the 64 KiB request limit, including JSON encoding. Split them into complete sections yourself. Nothing was shortened or sent.",
    );
  }
  return body;
}

export async function requestMeetingMinutes(
  transcript: string,
  language: SpeechLanguage,
  signal: AbortSignal,
) {
  return parseMeetingMinutes(
    await postJSON(
      "/api/minutes",
      minutesRequest(transcript, language),
      signal,
    ),
  );
}

// Only an explicit leading minutes request selects this read-only route. The
// discussion that follows never goes through command interpretation.
export function meetingCommand(
  transcript: string,
): { language: SpeechLanguage } | null {
  const match =
    /^\s*(?:(?:please|can you|could you)\s+)?(?:(?:take\s+)?(?:meeting\s+minutes|minutes\s+of\s+(?:the\s+)?meeting|summarize\s+(?:this\s+)?meeting|meeting\s+notes)\b|(?:बैठक\s+के\s+(?:नोट्स|मिनट्स)|मीटिंग\s+(?:नोट्स|मिनट्स)))/i.exec(
      transcript,
    );
  if (!match) return null;
  const directive =
    transcript
      .slice(match[0].length)
      .match(
        /^\s*(?:in\s+(English|Hindi)|(?:अंग्रेज़ी|अंग्रेजी|हिंदी|हिन्दी)\s*में)/i,
      )?.[0] ?? "";
  const hindi =
    /hindi|हिंदी|हिन्दी/i.test(directive) ||
    (!directive && /\p{Script=Devanagari}/u.test(match[0]));
  return { language: hindi ? "hi" : "en" };
}

export function minutesSpeech(
  summary: string,
  language: SpeechLanguage,
): string {
  if ([...summary].length <= 240) return summary;
  const sentences = summary.match(/.+?[.!?।](?=\s|$)/gu) ?? [];
  let spoken = "";
  for (const sentence of sentences) {
    const next = `${spoken} ${sentence.trim()}`.trim();
    if ([...next].length > 240) break;
    spoken = next;
  }
  return (
    spoken ||
    (language === "hi"
      ? "मीटिंग के मिनट्स सेव हो गए हैं। पूरा सारांश पढ़ें और ज़रूरत हो तो संपादित करें।"
      : "Your meeting minutes are saved. Read the full summary and edit it if needed.")
  );
}

export function confirmedReminderInstant(input: string): string {
  const date = new Date(input);
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)$/.exec(input);
  if (
    !parts ||
    !Number.isFinite(date.getTime()) ||
    date.getTime() <= Date.now() ||
    date.getFullYear() !== Number(parts[1]) ||
    date.getMonth() + 1 !== Number(parts[2]) ||
    date.getDate() !== Number(parts[3]) ||
    date.getHours() !== Number(parts[4]) ||
    date.getMinutes() !== Number(parts[5])
  ) {
    throw new Error(
      "Choose and confirm a valid future date and time in your timezone. No deadline was guessed.",
    );
  }
  return date.toISOString().replace(/Z$/, "+00:00");
}
