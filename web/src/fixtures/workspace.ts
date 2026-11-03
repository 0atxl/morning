import type {
  DraftResult,
  ReminderResult,
  WorkspaceResult,
} from "@/lib/results";

// Every command, contact, date and response in this module is a design fixture.
// These results are never submitted to /api/commands or stored as real reminders.
export const SAMPLE_COMMAND = "Remind me in ten minutes to check the oven.";
export const SAMPLE_CLARIFICATION_COMMAND = "Remind me to check the oven.";
export const SAMPLE_QUESTION = "When should I remind you to check the oven?";
export const SAMPLE_ERROR =
  "Morning couldn't interpret your command. Please try again.";

const draft: DraftResult = {
  id: "sample-draft-priya",
  sample: true,
  kind: "draft",
  title: "Draft to Priya",
  recipient: "Priya",
  to: "priya@example.test",
  subject: "Revised project timeline",
  body: "Hi Priya,\n\nCould you confirm the revised project timeline?",
  transcript:
    "Draft Priya an email asking her to confirm the revised project timeline.",
};

const followup: ReminderResult = {
  id: "sample-reminder-followup",
  sample: true,
  kind: "reminder",
  title: "Follow up",
  dueAt: "2026-11-06T10:00:00+05:30",
  timezone: "Asia/Kolkata",
  transcript: "Remind me on Friday at ten AM to follow up.",
};

export const SAMPLE_REMINDER: ReminderResult = {
  id: "sample-reminder-oven",
  sample: true,
  kind: "reminder",
  title: "Check the oven",
  dueAt: "2026-11-03T09:10:00+05:30",
  timezone: "Asia/Kolkata",
  transcript: SAMPLE_COMMAND,
};

export function initialResults(): WorkspaceResult[] {
  return [{ ...draft }, { ...followup }];
}

export const previewStates = [
  { value: "ready", label: "Ready" },
  { value: "listening", label: "Listening" },
  { value: "processing", label: "Processing" },
  { value: "saved", label: "Saved" },
  { value: "clarification", label: "Clarification" },
  { value: "error", label: "Error" },
  { value: "empty", label: "Empty" },
] as const;

export type PreviewState = (typeof previewStates)[number]["value"];
