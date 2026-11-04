import type { LookupResult } from "./lookup-result.ts";

type ResultBase = {
  id: string;
  title: string;
  transcript: string;
  sample?: boolean;
};

export type ReminderResult = ResultBase & {
  kind: "reminder";
  dueAt: string;
  timezone: string;
  repeat?: "daily" | "weekly" | "weekdays";
};

export type DraftResult = ResultBase & {
  kind: "draft";
  recipient: string;
  to: string;
  subject: string;
  body: string;
};

export type LookupWorkspaceResult = ResultBase & {
  kind: "lookup";
  lookup: LookupResult;
};

export type MeetingActionItem = {
  task: string;
  owner: string | null;
  deadline: string | null;
};

export type MeetingMinutes = {
  summary: string;
  decisions: string[];
  action_items: MeetingActionItem[];
  open_questions: string[];
};

export type MinutesResult = ResultBase & {
  kind: "minutes";
  minutes: MeetingMinutes;
};

// Browser presentation types. These are not the server's command response.
export type WorkspaceResult =
  | ReminderResult
  | DraftResult
  | LookupWorkspaceResult
  | MinutesResult;

export function gmailComposeUrl(draft: DraftResult) {
  const query = new URLSearchParams({
    view: "cm",
    fs: "1",
    to: draft.to,
    su: draft.subject,
    body: draft.body,
  });
  return `https://mail.google.com/mail/?${query}`;
}

export function minutesComposeUrl(minutes: MeetingMinutes): string {
  const query = new URLSearchParams({
    view: "cm",
    fs: "1",
    su: `Meeting Minutes: ${minutes.summary.slice(0, 60)}`,
    body: resultText({
      id: "minutes",
      title: "Meeting Minutes",
      transcript: "",
      kind: "minutes",
      minutes,
    }),
  });
  return `https://mail.google.com/mail/?${query}`;
}

export function deadlineInstant(deadline?: string | null): string {
  const now = new Date();
  if (!deadline || !deadline.trim()) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    return tomorrow.toISOString();
  }
  const text = deadline.trim().toLowerCase();
  const days = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const dayIndex = days.indexOf(text);
  if (dayIndex !== -1) {
    const currentDay = now.getDay();
    let daysAhead = dayIndex - currentDay;
    if (daysAhead <= 0) daysAhead += 7;
    const target = new Date(now);
    target.setDate(target.getDate() + daysAhead);
    target.setHours(9, 0, 0, 0);
    return target.toISOString();
  }
  if (text === "tomorrow" || text === "kal" || text === "कल") {
    const target = new Date(now);
    target.setDate(target.getDate() + 1);
    target.setHours(9, 0, 0, 0);
    return target.toISOString();
  }
  if (text === "today" || text === "aaj" || text === "आज") {
    const target = new Date(now);
    target.setHours(17, 0, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setTime(now.getTime() + 2 * 3600 * 1000);
    }
    return target.toISOString();
  }
  const parsed = Date.parse(deadline);
  if (!Number.isNaN(parsed) && parsed > now.getTime()) {
    return new Date(parsed).toISOString();
  }
  const fallback = new Date(now);
  fallback.setDate(fallback.getDate() + 1);
  fallback.setHours(9, 0, 0, 0);
  return fallback.toISOString();
}

export function nextRecurringDue(
  dueAt: string,
  repeat: "daily" | "weekly" | "weekdays",
): string {
  const current = new Date(dueAt);
  const now = new Date();
  const next = new Date(current);

  do {
    if (repeat === "daily") {
      next.setDate(next.getDate() + 1);
    } else if (repeat === "weekly") {
      next.setDate(next.getDate() + 7);
    } else if (repeat === "weekdays") {
      next.setDate(next.getDate() + 1);
      if (next.getDay() === 6) {
        next.setDate(next.getDate() + 2);
      } else if (next.getDay() === 0) {
        next.setDate(next.getDate() + 1);
      }
    }
  } while (next.getTime() <= now.getTime());

  return next.toISOString();
}

function calendarInstant(value: string | Date) {
  return new Date(value)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

export function googleCalendarUrl(reminder: ReminderResult) {
  const start = calendarInstant(reminder.dueAt);
  const end = calendarInstant(new Date(Date.parse(reminder.dueAt) + 60_000));
  const query = new URLSearchParams({
    action: "TEMPLATE",
    text: reminder.title,
    dates: `${start}/${end}`,
    stz: reminder.timezone,
    etz: reminder.timezone,
    details:
      "Reminder from Morning. This calendar copy does not sync with later edits in Morning.",
  });
  return `https://calendar.google.com/calendar/r/eventedit?${query}`;
}

function calendarText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

function foldCalendarLine(value: string) {
  const encoder = new TextEncoder();
  let line = "";
  let bytes = 0;
  const lines: string[] = [];
  for (const character of value) {
    const width = encoder.encode(character).length;
    if (bytes + width > 75) {
      lines.push(line);
      line = " ";
      bytes = 1;
    }
    line += character;
    bytes += width;
  }
  lines.push(line);
  return lines.join("\r\n");
}

// Export a one-minute, transparent calendar marker at the saved due instant.
// Stable UID, escaped text and UTF-8-aware folding follow RFC 5545.
export function reminderCalendar(reminder: ReminderResult, stamp = new Date()) {
  return (
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Morning//Reminders//EN",
      "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT",
      `UID:${encodeURIComponent(reminder.id)}@morning.atuls.me`,
      `DTSTAMP:${calendarInstant(stamp)}`,
      `DTSTART:${calendarInstant(reminder.dueAt)}`,
      `DTEND:${calendarInstant(new Date(Date.parse(reminder.dueAt) + 60_000))}`,
      `SUMMARY:${calendarText(reminder.title)}`,
      `DESCRIPTION:${calendarText(`Reminder from Morning. Timezone: ${reminder.timezone}. Calendar copies do not sync with later edits in Morning.`)}`,
      "TRANSP:TRANSPARENT",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:PT0S",
      `DESCRIPTION:${calendarText(reminder.title)}`,
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ]
      .map(foldCalendarLine)
      .join("\r\n") + "\r\n"
  );
}

export function formatDue(reminder: ReminderResult, full = false) {
  const date = new Date(reminder.dueAt);
  const day = new Intl.DateTimeFormat("en", {
    timeZone: reminder.timezone,
    weekday: full ? "long" : "short",
    month: full ? "long" : "short",
    day: "numeric",
    ...(full ? { year: "numeric" as const } : {}),
  }).format(date);
  const time = new Intl.DateTimeFormat("en", {
    timeZone: reminder.timezone,
    hour: "numeric",
    minute: "2-digit",
    ...(full ? { timeZoneName: "short" as const } : {}),
  }).format(date);
  return `${day} · ${time}`;
}

export function resultText(result: WorkspaceResult) {
  if (result.kind === "minutes") {
    const m = result.minutes;
    const lines = [
      result.title.toUpperCase(),
      "=".repeat(result.title.length),
      "",
      "SUMMARY",
      m.summary,
      "",
    ];
    if (m.decisions && m.decisions.length > 0) {
      lines.push("DECISIONS", ...m.decisions.map((d) => `• ${d}`), "");
    }
    if (m.action_items && m.action_items.length > 0) {
      lines.push(
        "ACTION ITEMS",
        ...m.action_items.map((item) => {
          let line = `• ${item.task}`;
          if (item.owner) line += ` (Owner: ${item.owner})`;
          if (item.deadline) line += ` [Deadline: ${item.deadline}]`;
          return line;
        }),
        "",
      );
    }
    if (m.open_questions && m.open_questions.length > 0) {
      lines.push(
        "OPEN QUESTIONS",
        ...m.open_questions.map((q) => `• ${q}`),
        "",
      );
    }
    if (result.transcript) {
      lines.push("TRANSCRIPT", result.transcript);
    }
    return lines.join("\n");
  }
  if (result.kind === "lookup") {
    const lookup = result.lookup;
    if (lookup.kind === "wiki") {
      return [
        result.title.toUpperCase(),
        "=".repeat(result.title.length),
        `Summary from Wikipedia (Looked up: ${lookup.looked_up_at})`,
        "",
        lookup.answer,
        "",
        ...lookup.sources.map(
          (source) => `Source: ${source.title}\nURL: ${source.url}`,
        ),
        "",
        `Transcript:\n${result.transcript}`,
      ].join("\n");
    }
    return [
      lookup.answer,
      `Looked up: ${lookup.looked_up_at}`,
      ...(lookup.data_time
        ? [`Data time: ${lookup.data_time} (${lookup.timezone})`]
        : []),
      ...lookup.sources.map(
        (source) =>
          `${source.title}\n${source.publisher}${source.published_at ? ` · Published: ${source.published_at}` : ""}\n${source.url}`,
      ),
      `Transcript\n${result.transcript}`,
    ].join("\n\n");
  }
  if (result.kind === "draft") {
    return `To: ${result.to}\nSubject: ${result.subject}\n\n${result.body}`;
  }
  return `${result.title}\n${formatDue(result, true)}\n\nTranscript\n${result.transcript}`;
}

export function downloadResult(
  result: WorkspaceResult,
  format: "txt" | "ics" = "txt",
) {
  if (format === "ics" && result.kind !== "reminder")
    throw new Error("Only reminders can be exported to a calendar.");
  const content =
    format === "ics" && result.kind === "reminder"
      ? reminderCalendar(result)
      : resultText(result);
  const url = URL.createObjectURL(
    new Blob([content], {
      type:
        format === "ics"
          ? "text/calendar;charset=utf-8"
          : "text/plain;charset=utf-8",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${
    result.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "morning"
  }.${format}`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function localInputDate(isoDate: string) {
  const date = new Date(isoDate);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
