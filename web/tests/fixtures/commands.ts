import type {
  CommandRequest,
  DraftAction,
  ReminderAction,
} from "../../src/lib/command-api.ts";

export const request: CommandRequest = {
  command_id: "draft-follow-up-1",
  transcript:
    "Draft Priya an email asking her to confirm the revised timeline, and remind me Friday at ten AM to follow up.",
  now: "2026-11-03T09:00:00+05:30",
  timezone: "Asia/Kolkata",
  contacts: [
    { id: "priya-shah", name: "Priya Shah", email: "priya.shah@example.com" },
  ],
};
export const draft: DraftAction = {
  type: "draft_email",
  to_contact_id: "priya-shah",
  subject: "Confirm the revised timeline",
  body: "Hi Priya,\n\nCould you confirm the revised timeline?\n\nThanks!",
};
export const reminder: ReminderAction = {
  type: "create_reminder",
  title: "Follow up with Priya",
  due_at: "2026-11-06T10:00:00+05:30",
};
