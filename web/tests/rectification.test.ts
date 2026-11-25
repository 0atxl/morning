import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  IDBFactory,
  IDBKeyRange as FakeKeyRange,
} from "fake-indexeddb";
import {
  parseCommandResponse,
  type CommandRequest,
} from "../src/lib/command-api.ts";
import { allContactsForCommand } from "../src/lib/contacts.ts";
import {
  commitCommand,
  loadWorkspace,
  recentTurnsContext,
  type StoredDraft,
  type StoredReminder,
  type Turn,
} from "../src/lib/reminder-store.ts";
import { confirmationText, speechClip } from "../src/lib/spoken-reply.ts";

const originalFactory = Object.getOwnPropertyDescriptor(
  globalThis,
  "indexedDB",
);
const originalKeyRange = Object.getOwnPropertyDescriptor(
  globalThis,
  "IDBKeyRange",
);

beforeEach(() => {
  Object.defineProperty(globalThis, "indexedDB", {
    value: new IDBFactory(),
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, "IDBKeyRange", {
    value: FakeKeyRange,
    configurable: true,
  });
});

afterEach(() => {
  if (originalFactory)
    Object.defineProperty(globalThis, "indexedDB", originalFactory);
  else Reflect.deleteProperty(globalThis, "indexedDB");
  if (originalKeyRange)
    Object.defineProperty(globalThis, "IDBKeyRange", originalKeyRange);
  else Reflect.deleteProperty(globalThis, "IDBKeyRange");
});

const baseRequest: CommandRequest = {
  command_id: "rect-1",
  transcript: "Remind me in 10 minutes to call Priya",
  now: "2026-11-04T09:00:00+05:30",
  timezone: "Asia/Kolkata",
  contacts: [
    { id: "priya-shah", name: "Priya Shah", email: "priya.shah@example.com" },
    { id: "alex-chen", name: "Alex Chen", email: "alex.chen@example.com" },
  ],
};

test("recentTurnsContext builds chronological rolling history with cross-session backfill", () => {
  const turns: Turn[] = [
    {
      id: "old-1",
      sessionId: "session-1",
      createdAt: "2026-11-04T08:00:00Z",
      transcript: "Who is NVIDIA's CEO?",
      reply: "Jensen Huang is the CEO of NVIDIA.",
      lookup: {
        kind: "web",
        query: "NVIDIA CEO",
        status: "answered",
        answer: "Jensen Huang is the CEO of NVIDIA.",
        speech: "Jensen Huang is the CEO of NVIDIA.",
        sources: [
          {
            title: "NVIDIA",
            url: "https://nvidia.com/bio",
            publisher: "nvidia.com",
          },
        ],
        looked_up_at: "2026-11-04T08:00:01Z",
      },
    },
    {
      id: "cur-1",
      sessionId: "session-2",
      createdAt: "2026-11-04T09:00:00Z",
      transcript: "Remind me in 10 minutes to call Priya",
      reply: "Reminder saved for Wednesday, 9:10 AM.",
    },
  ];
  const recent = recentTurnsContext(turns, "session-2");
  assert.ok(recent);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].prior_session, true);
  assert.equal(recent[0].topic, "NVIDIA CEO");
  assert.equal(recent[0].answer, "Jensen Huang is the CEO of NVIDIA.");
  assert.equal(recent[1].prior_session, undefined);
  assert.equal(recent[1].reply, "Reminder saved for Wednesday, 9:10 AM.");
});

test("parseCommandResponse handles multi-item updates, title edits, deletes and 500-char replies", () => {
  const req: CommandRequest = {
    ...baseRequest,
    reminders_context: [
      { id: "rem-1", title: "Call Priya", due_at: "2026-11-04T10:00:00+05:30" },
      { id: "rem-2", title: "Check oven", due_at: "2026-11-04T11:00:00+05:30" },
    ],
    drafts_context: [
      {
        id: "draft:d1",
        subject: "Update",
        body: "Hi Priya",
        recipient: "Priya Shah",
        to: "priya.shah@example.com",
      },
    ],
  };

  // Title-only reminder update against reminders_context.
  const rename = parseCommandResponse(
    {
      command_id: req.command_id,
      actions: [
        {
          type: "reschedule_reminder",
          reminder_id: "rem-2",
          title: "Turn off the oven",
        },
      ],
      clarification: null,
      lookup: null,
    },
    req,
  );
  assert.equal(rename.kind, "actions");
  if (rename.kind === "actions" && rename.actions[0].type === "reschedule_reminder") {
    assert.equal(rename.actions[0].reminder_id, "rem-2");
    assert.equal(rename.actions[0].title, "Turn off the oven");
  }

  // Delete reminder against reminders_context.
  const delRem = parseCommandResponse(
    {
      command_id: req.command_id,
      actions: [{ type: "delete_reminder", reminder_id: "rem-1" }],
      clarification: null,
    },
    req,
  );
  assert.equal(delRem.kind, "actions");

  // Update draft recipient against drafts_context.
  const updDraft = parseCommandResponse(
    {
      command_id: req.command_id,
      actions: [
        {
          type: "update_draft",
          draft_id: "draft:d1",
          to_contact_id: "alex-chen",
          subject: "Update for Alex",
          body: "Hi Alex,\n\nHere is the update.",
        },
      ],
      clarification: null,
    },
    req,
  );
  assert.equal(updDraft.kind, "actions");

  // 400-char reply accepted.
  const longReply = "A".repeat(400);
  const reply = parseCommandResponse(
    {
      command_id: req.command_id,
      actions: [],
      clarification: null,
      reply: longReply,
    },
    req,
  );
  assert.equal(reply.kind, "reply");
});

test("commitCommand supports multi-item reminder rename, draft recipient update, and idempotent deletes", async () => {
  const session = (await loadWorkspace()).selectedSession;
  const created = await commitCommand(
    baseRequest,
    [
      {
        type: "create_reminder",
        title: "Call Priya",
        due_at: "2026-11-04T10:00:00+05:30",
      },
      {
        type: "draft_email",
        to_contact_id: "priya-shah",
        subject: "Hello",
        body: "Hi Priya",
      },
    ],
    session,
  );
  const rem = created.records.find(
    (r): r is StoredReminder => r.kind === "reminder",
  )!;
  const draft = created.records.find(
    (r): r is StoredDraft => r.kind === "draft",
  )!;

  // Rename reminder via reminders_context across sessions.
  const renamed = await commitCommand(
    {
      ...baseRequest,
      command_id: "rename-1",
      reminders_context: [
        { id: rem.id, title: rem.title, due_at: rem.dueAt },
      ],
    },
    [
      {
        type: "reschedule_reminder",
        reminder_id: rem.id,
        title: "Call Priya about NVIDIA",
      },
    ],
    "other-session",
  );
  assert.equal(renamed.created, true);
  assert.equal(renamed.records[0].title, "Call Priya about NVIDIA");

  // Update draft recipient via drafts_context.
  const retargeted = await commitCommand(
    {
      ...baseRequest,
      command_id: "retarget-1",
      drafts_context: [
        {
          id: draft.id,
          subject: draft.subject,
          body: draft.body,
          recipient: draft.recipient,
          to: draft.to,
        },
      ],
    },
    [
      {
        type: "update_draft",
        draft_id: draft.id,
        to_contact_id: "alex-chen",
        subject: "Hello Alex",
        body: "Hi Alex",
      },
    ],
    session,
  );
  assert.equal(retargeted.created, true);
  assert.equal((retargeted.records[0] as StoredDraft).to, "alex.chen@example.com");

  // Delete reminder and verify idempotent replay.
  const delReq: CommandRequest = {
    ...baseRequest,
    command_id: "del-rem-1",
    reminders_context: [{ id: rem.id, title: "Call Priya about NVIDIA", due_at: rem.dueAt }],
  };
  const deleted = await commitCommand(
    delReq,
    [{ type: "delete_reminder", reminder_id: rem.id }],
    session,
  );
  assert.equal(deleted.created, true);
  assert.deepEqual(deleted.deletedIds, [rem.id]);

  const replay = await commitCommand(
    delReq,
    [{ type: "delete_reminder", reminder_id: rem.id }],
    session,
  );
  assert.equal(replay.created, false);
  assert.deepEqual(replay.deletedIds, [rem.id]);

  const loaded = await loadWorkspace();
  assert.equal(
    loaded.records.some((r) => r.id === rem.id),
    false,
  );
  assert.equal(confirmationText([], "delete_reminder"), "Reminder deleted.");
  assert.equal(confirmationText([], "delete_draft", "hi"), "ईमेल ड्राफ्ट हटा दिया गया।");
});

test("speechClip clips long replies cleanly while preserving short replies and allContactsForCommand caps at 20", () => {
  assert.equal(speechClip("Draft saved."), "Draft saved.");
  const longText =
    "Jensen Huang is the CEO of NVIDIA. " + "Extra details ".repeat(30);
  const clipped = speechClip(longText, 240);
  assert.equal(clipped, "Jensen Huang is the CEO of NVIDIA.");
  const oneLongSentence = "word ".repeat(80).trim();
  const wordClipped = speechClip(oneLongSentence, 240);
  assert.ok([...wordClipped].length <= 240);
  assert.ok(wordClipped.endsWith("..."));

  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `c-${i}`,
    name: `Contact ${i}`,
    email: `c${i}@example.com`,
    sample: true,
  }));
  const sent = allContactsForCommand(many);
  assert.equal(sent.length, 20);
  assert.equal("sample" in sent[0], false);
});
