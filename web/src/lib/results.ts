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
};

export type DraftResult = ResultBase & {
  kind: "draft";
  recipient: string;
  to: string;
  subject: string;
  body: string;
};

// Browser presentation types. These are not the server's command response.
export type WorkspaceResult = ReminderResult | DraftResult;

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
