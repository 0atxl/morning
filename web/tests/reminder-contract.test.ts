import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseCommandResponse,
  type CommandRequest,
} from "../src/lib/command-api.ts";
import { TranscriptBuffer } from "../src/lib/transcript.ts";

// Definitions only. Running this suite requires separate user confirmation.
const request: CommandRequest = {
  command_id: "one-recording",
  transcript: "Remind me in ten minutes to check the oven",
  now: "2026-11-03T09:00:00+05:30",
  timezone: "Asia/Kolkata",
};
const reminder = {
  type: "create_reminder",
  title: "Check the oven",
  due_at: "2026-11-03T09:10:00+05:30",
};
const frame = (start: number, text: string, final = true, duration = 1) => ({
  type: "Results",
  start,
  duration,
  is_final: final,
  channel: { alternatives: [{ transcript: text }] },
});

test("interim revisions replace one another and Stop's last final segment is retained", () => {
  const captions = new TranscriptBuffer();
  captions.accept(frame(0, "Remind", false));
  captions.accept(frame(0, "Remind me in ten minutes", false));
  captions.accept(frame(0, "Remind me in ten minutes"));
  captions.accept(frame(1, "to check", false));
  assert.deepEqual(captions.captions(), {
    final: "Remind me in ten minutes",
    interim: "to check",
  });
  captions.accept(frame(1, "to check the oven."));
  assert.deepEqual(captions.captions(), {
    final: "Remind me in ten minutes to check the oven.",
    interim: "",
  });
});

test("pauses and repeated frames don't duplicate words; actual repeated phrases survive", () => {
  const captions = new TranscriptBuffer();
  captions.accept({ ...frame(0, "Check"), speech_final: true });
  captions.accept(frame(0, "Check"));
  captions.accept(frame(2, "check the oven."));
  assert.equal(captions.captions().final, "Check check the oven.");
});

test("final audio positions establish order and stale interim frames stay out", () => {
  const captions = new TranscriptBuffer();
  captions.accept(frame(2, "the oven."));
  captions.accept(frame(0, "Check", true, 2));
  captions.accept(frame(0, "Check the", false));
  assert.deepEqual(captions.captions(), {
    final: "Check the oven.",
    interim: "",
  });
});

test("malformed captions fail without losing finalized words", () => {
  const captions = new TranscriptBuffer();
  captions.accept(frame(0, "Check"));
  assert.throws(() =>
    captions.accept({ ...frame(1, "the oven"), duration: -1 }),
  );
  assert.equal(captions.captions().final, "Check");
});

test("the documented reminder and missing-time clarification remain distinct", () => {
  assert.deepEqual(
    parseCommandResponse(
      {
        command_id: request.command_id,
        actions: [reminder],
        clarification: null,
      },
      request,
    ),
    { kind: "actions", actions: [reminder] },
  );
  assert.deepEqual(
    parseCommandResponse(
      {
        command_id: request.command_id,
        actions: [],
        clarification: "When should I remind you?",
      },
      request,
    ),
    {
      kind: "clarification",
      question: "When should I remind you?",
      options: [],
    },
  );
});

test("mismatched command IDs, malformed compound actions and unsupported actions cannot be partially saved", () => {
  for (const response of [
    {
      command_id: "another-recording",
      actions: [reminder],
      clarification: null,
    },
    {
      command_id: request.command_id,
      actions: [reminder, { type: "draft_email" }],
      clarification: null,
    },
    {
      command_id: request.command_id,
      actions: [{ type: "delete_reminder" }],
      clarification: null,
    },
    {
      command_id: request.command_id,
      actions: [reminder],
      clarification: "When?",
    },
  ])
    assert.throws(() => parseCommandResponse(response, request));
});

test("a bad date, past time or blank title cannot be saved", () => {
  for (const action of [
    { ...reminder, due_at: "not-a-date" },
    { ...reminder, due_at: "2026-11-03T08:00:00+05:30" },
    { ...reminder, title: " " },
  ])
    assert.throws(() =>
      parseCommandResponse(
        {
          command_id: request.command_id,
          actions: [action],
          clarification: null,
        },
        request,
      ),
    );
});
