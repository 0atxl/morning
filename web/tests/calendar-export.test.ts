import assert from "node:assert/strict";
import { test } from "node:test";
import {
  googleCalendarUrl,
  reminderCalendar,
  type ReminderResult,
} from "../src/lib/results.ts";

const reminder: ReminderResult = {
  id: "saved-reminder",
  kind: "reminder",
  title: "Drink water",
  transcript: "Remind me in ten minutes.",
  dueAt: "2026-11-03T09:10:00+05:30",
  timezone: "Asia/Kolkata",
};

test("calendar export uses the saved UTC instant, a stable UID and a one-minute marker", () => {
  const calendar = reminderCalendar(reminder, new Date("2026-11-03T03:30:00Z"));
  assert.match(calendar, /DTSTART:20261103T034000Z\r\n/);
  assert.match(calendar, /DTEND:20261103T034100Z\r\n/);
  assert.match(calendar, /UID:saved-reminder@morning.atuls.me/);
  assert.match(calendar, /BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:PT0S/);
  assert.ok(calendar.endsWith("END:VCALENDAR\r\n"));
  const updated = reminderCalendar({
    ...reminder,
    dueAt: "2026-11-03T09:12:00+05:30",
  });
  assert.match(updated, /DTSTART:20261103T034200Z/);
  assert.match(updated, /UID:saved-reminder@morning.atuls.me/);
  const url = new URL(googleCalendarUrl(reminder));
  assert.equal(url.hostname, "calendar.google.com");
  assert.equal(url.searchParams.get("text"), reminder.title);
  assert.equal(
    url.searchParams.get("dates"),
    "20261103T034000Z/20261103T034100Z",
  );
  assert.equal(url.searchParams.get("stz"), reminder.timezone);
});

test("calendar text is escaped and folded without splitting UTF-8 characters or injecting properties", () => {
  const title =
    "नमस्ते, slides; \\ request\nATTENDEE:intruder@example.com " +
    "水".repeat(60);
  const calendar = reminderCalendar({ ...reminder, title });
  const unfolded = calendar.replace(/\r\n /g, "");
  assert.ok(
    unfolded.includes(
      "SUMMARY:नमस्ते\\, slides\\; \\\\ request\\nATTENDEE:intruder@example.com",
    ),
  );
  assert.equal(
    calendar.split("\r\n").filter((line) => line.startsWith("ATTENDEE:"))
      .length,
    0,
  );
  assert.equal(calendar.includes("\ufffd"), false);
  for (const line of calendar.split("\r\n"))
    assert.ok(new TextEncoder().encode(line).length <= 75);
});
