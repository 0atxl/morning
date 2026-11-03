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

export function downloadResult(result: WorkspaceResult) {
  const url = URL.createObjectURL(
    new Blob([resultText(result)], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${
    result.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "morning"
  }.txt`;
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
