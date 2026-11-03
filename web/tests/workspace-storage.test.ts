import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  IDBFactory,
  IDBKeyRange as FakeKeyRange,
  IDBObjectStore as FakeObjectStore,
} from "fake-indexeddb";
import {
  addGuestContact,
  acknowledgeReminderMail,
  commitCommand,
  loadWorkspace,
  dismissReminderAlerts,
  pollReminders,
  recordsForCommand,
  selectWorkspaceSession,
  storeTurn,
  updateResult,
  type StoredDraft,
  type StoredReminder,
} from "../src/lib/reminder-store.ts";
import { request, draft, reminder } from "./fixtures/commands.ts";

// Definitions only. Each approved run gets an isolated in-memory database.
// No provider, browser profile or real guest database is touched by this suite.
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

test("background polls preserve a due alert; foreground chimes once and dismissal survives reload", async () => {
  const {
    records: [saved],
  } = await commitCommand(request, [reminder]);
  assert.equal(saved.kind, "reminder");
  const now = Date.parse(reminder.due_at);
  const background = await pollReminders(now);
  assert.equal(background.due.length, 1);
  assert.equal(background.ring.length, 0);
  const tabs = await Promise.all([
    pollReminders(now, () => true),
    pollReminders(now, () => true),
  ]);
  assert.equal(tabs.flatMap((tab) => tab.ring).length, 1);
  assert.equal(tabs.flatMap((tab) => tab.due).length, 2);
  await loadWorkspace();
  assert.equal((await pollReminders(now)).due.length, 1);
  await dismissReminderAlerts([saved as StoredReminder]);
  await loadWorkspace();
  assert.equal((await pollReminders(now)).due.length, 0);
  if (saved.kind !== "reminder") return;
  await updateResult({ ...saved, dueAt: new Date(now + 60_000).toISOString() });
  const rescheduled = await pollReminders(now + 60_000, () => true);
  assert.equal(rescheduled.due.length, 1);
  assert.equal(rescheduled.ring.length, 1);
});

test("acknowledging an older mail request cannot accept a newer edit", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: { getItem: () => "fixture-owner-key", setItem: () => {} },
      dispatchEvent: () => true,
    },
  });
  try {
    const {
      records: [saved],
    } = await commitCommand(request, [reminder]);
    const first = (await pollReminders(0)).pending[0];
    assert.ok(first);
    await updateResult({ ...saved, title: "A newer title" });
    const edited = (await pollReminders(0)).pending[0];
    assert.ok(edited.revision > first.revision);
    await acknowledgeReminderMail(first);
    assert.deepEqual((await pollReminders(0)).pending, [edited]);
    await acknowledgeReminderMail(edited);
    const accepted = await pollReminders(0);
    assert.equal(accepted.hasMail, true);
    assert.deepEqual(accepted.pending, []);
    if (saved.kind !== "reminder") throw new Error("missing fixture reminder");
    const correctedDue = new Date(
      Date.parse(saved.dueAt) + 120_000,
    ).toISOString();
    await commitCommand(
      {
        ...request,
        command_id: "owner-correction",
        reminder_context: { id: saved.id, due_at: saved.dueAt },
      },
      [
        {
          type: "reschedule_reminder",
          reminder_id: saved.id,
          due_at: correctedDue,
        },
      ],
    );
    const mail = (await pollReminders(0)).pending;
    assert.equal(mail.length, 1);
    assert.equal(mail[0].id, saved.id);
    assert.equal(mail[0].dueAt, correctedDue);
    assert.ok(mail[0].revision > edited.revision);
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("a spoken correction updates the original conversation once and preserves an edited draft", async () => {
  const session = (await loadWorkspace()).selectedSession;
  const { records } = await commitCommand(request, [reminder, draft], session);
  const original = records.find(
    (record): record is StoredReminder => record.kind === "reminder",
  )!;
  const email = records.find(
    (record): record is StoredDraft => record.kind === "draft",
  )!;
  await updateResult({ ...email, body: "My reviewed draft" });
  await selectWorkspaceSession();
  const correction = {
    ...request,
    command_id: "correction",
    transcript: "Change the existing task to two minutes.",
    reminder_context: { id: original.id, due_at: original.dueAt },
  };
  const action = {
    type: "reschedule_reminder",
    reminder_id: original.id,
    due_at: "2026-11-03T09:02:00+05:30",
  } as const;
  const first = await commitCommand(correction, [action], session);
  assert.equal(first.created, true);
  assert.equal(first.records[0].id, original.id);
  assert.equal(first.records[0].commandId, original.commandId);
  assert.equal(first.records[0].sessionId, session);
  const updated = first.records[0] as StoredReminder;
  await updateResult({ ...updated, title: "Edited after correction" });
  const replay = await commitCommand(correction, [action], session);
  assert.equal(replay.created, false);
  assert.equal(replay.records[0].title, "Edited after correction");
  const loaded = await loadWorkspace();
  assert.equal(loaded.records.length, 2);
  assert.equal(
    loaded.records.find((record) => record.kind === "draft")?.kind,
    "draft",
  );
  assert.equal(
    (loaded.records.find((record) => record.kind === "draft") as StoredDraft)
      .body,
    "My reviewed draft",
  );
  assert.equal((await receipts()).length, 2);
});

test("stale or cross-conversation corrections abort without a receipt or changed due time", async () => {
  const session = (await loadWorkspace()).selectedSession;
  const {
    records: [record],
  } = await commitCommand(request, [reminder], session);
  const original = record as StoredReminder;
  const correction = {
    ...request,
    command_id: "rejected-correction",
    reminder_context: { id: original.id, due_at: original.dueAt },
  };
  const action = {
    type: "reschedule_reminder",
    reminder_id: original.id,
    due_at: "2026-11-03T09:02:00+05:30",
  } as const;
  await assert.rejects(
    commitCommand(correction, [action], "another-session"),
    /outside this conversation/,
  );
  await updateResult({ ...original, dueAt: "2026-11-06T11:00:00+05:30" });
  await assert.rejects(commitCommand(correction, [action], session), /changed/);
  assert.equal((await receipts()).length, 1);
  assert.equal(
    ((await loadWorkspace()).records[0] as StoredReminder).dueAt,
    "2026-11-06T11:00:00+05:30",
  );
});

test("a conversational reply persists in its own turn without creating saved results", async () => {
  const sessionId = (await loadWorkspace()).selectedSession;
  const turn = {
    id: "greeting",
    sessionId,
    createdAt: request.now,
    transcript: "Hello, what can you do?",
    reply: "I can help with reminders and editable email drafts.",
  };
  await storeTurn(turn);
  await storeTurn(turn);
  const loaded = await loadWorkspace();
  assert.deepEqual(loaded.turns, [turn]);
  assert.deepEqual(loaded.records, []);
  assert.deepEqual(await receipts(), []);
});

test("a voice draft edit updates once, preserves the recipient and reminder, and rejects stale snapshots", async () => {
  const session = (await loadWorkspace()).selectedSession;
  const { records } = await commitCommand(request, [draft, reminder], session);
  const email = records.find(
    (record): record is StoredDraft => record.kind === "draft",
  )!;
  const unchangedReminder = records.find(
    (record) => record.kind === "reminder",
  );
  const edit = {
    ...request,
    command_id: "draft-edit",
    transcript: "Make that email more detailed.",
    draft_context: {
      id: email.id,
      subject: email.subject,
      body: email.body,
      recipient: email.recipient,
      to: email.to,
    },
  };
  const action = {
    type: "update_draft",
    draft_id: email.id,
    subject: "A fuller subject",
    body: "The complete, revised message.",
  } as const;
  const first = await commitCommand(edit, [action], session);
  assert.equal(first.created, true);
  assert.equal(first.records[0].id, email.id);
  const updated = first.records[0] as StoredDraft;
  assert.equal(updated.to, email.to);
  assert.equal(updated.commandId, email.commandId);
  await updateResult({ ...updated, body: "My later manual edit" });
  const replay = await commitCommand(edit, [action], session);
  assert.equal(replay.created, false);
  assert.equal((replay.records[0] as StoredDraft).body, "My later manual edit");
  await assert.rejects(
    commitCommand({ ...edit, command_id: "stale-edit" }, [action], session),
    /draft changed/,
  );
  await assert.rejects(
    commitCommand(
      {
        ...edit,
        command_id: "wrong-session",
        draft_context: {
          ...edit.draft_context,
          subject: updated.subject,
          body: "My later manual edit",
        },
      },
      [action],
      "another-session",
    ),
    /outside this conversation/,
  );
  const loaded = await loadWorkspace();
  assert.equal(loaded.records.length, 2);
  assert.deepEqual(
    loaded.records.find((record) => record.kind === "reminder"),
    unchangedReminder,
  );
  assert.equal((await receipts()).length, 2);
});

function legacyDatabase(record: StoredReminder, receipt: boolean) {
  return new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("morning-guest", 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("reminders", { keyPath: "id" }).add(record);
      const commands = open.result.createObjectStore("commands", {
        keyPath: "commandId",
      });
      if (receipt)
        commands.add({ commandId: record.commandId, reminderId: record.id });
    };
    open.onsuccess = () => {
      open.result.close();
      resolve();
    };
    open.onerror = () => reject(open.error);
  });
}

function receipts() {
  return new Promise<unknown[]>((resolve, reject) => {
    const open = indexedDB.open("morning-guest");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("commands", "readonly");
      const read = tx.objectStore("commands").getAll();
      tx.oncomplete = () => {
        open.result.close();
        resolve(read.result);
      };
      tx.onabort = () => {
        open.result.close();
        reject(tx.error);
      };
    };
  });
}

function putFixture(store: string, record: StoredDraft) {
  return new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("morning-guest");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(store, "readwrite");
      tx.objectStore(store).add(record);
      tx.oncomplete = () => {
        open.result.close();
        resolve();
      };
      tx.onabort = () => {
        open.result.close();
        reject(tx.error);
      };
    };
  });
}

test("v1 upgrade preserves an edited reminder and its existing receipt", async () => {
  const old = recordsForCommand(request, [reminder])[0] as StoredReminder;
  old.title = "Edited before upgrade";
  await legacyDatabase(old, true);
  const loaded = await loadWorkspace();
  assert.deepEqual(loaded.records, [old]);
  assert.ok(
    loaded.contacts.some(
      (contact) => contact.name === "Priya Shah" && contact.sample,
    ),
  );
  const replay = await commitCommand(request, [draft, reminder]);
  assert.equal(replay.created, false);
  assert.deepEqual(replay.records, [old]);
  assert.equal((await receipts()).length, 1);
});

test("a legacy reminder without a receipt is reused without overwriting edits or adding a draft on replay", async () => {
  const old = {
    ...recordsForCommand(request, [reminder])[0],
    title: "Keep my edit",
  } as StoredReminder;
  await legacyDatabase(old, false);
  const replay = await commitCommand(request, [draft, reminder]);
  assert.equal(replay.created, false);
  assert.deepEqual(replay.records, [old]);
  assert.deepEqual((await loadWorkspace()).records, [old]);
  assert.equal((await receipts()).length, 1);
});

test("a compound command commits two results and one receipt; replay preserves an edited draft", async () => {
  const saved = await commitCommand(request, [draft, reminder]);
  assert.equal(saved.created, true);
  assert.equal(saved.records.length, 2);
  assert.equal((await receipts()).length, 1);
  const savedDraft = saved.records.find(
    (record): record is StoredDraft => record.kind === "draft",
  )!;
  await updateResult({
    ...savedDraft,
    body: "My edited message",
    subject: "My edited subject",
  });
  const replay = await commitCommand(request, [draft, reminder]);
  assert.equal(replay.created, false);
  assert.equal(
    replay.records.find((record) => record.kind === "draft")?.body,
    "My edited message",
  );
  assert.equal((await loadWorkspace()).records.length, 2);
  assert.equal((await receipts()).length, 1);
});

test("simultaneous attempts serialize on the command receipt", async () => {
  await loadWorkspace();
  const attempts = await Promise.all([
    commitCommand(request, [draft, reminder]),
    commitCommand(request, [draft, reminder]),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.created).length, 1);
  assert.equal((await loadWorkspace()).records.length, 2);
  assert.equal((await receipts()).length, 1);
});

test("a failed draft write rolls back the reminder and receipt, then an explicit retry can save both", async (context) => {
  await loadWorkspace();
  const occupied = {
    ...recordsForCommand(request, [draft])[0],
    id: "occupied",
    commandId: "another-command",
  } as StoredDraft;
  await putFixture("drafts", occupied);
  const originalAdd = FakeObjectStore.prototype.add;
  const injected = context.mock.method(
    FakeObjectStore.prototype,
    "add",
    function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      // A real IndexedDB ConstraintError request failure aborts the transaction.
      // It avoids throwing an unrelated uncaught exception from an event handler.
      const stored =
        this.name === "drafts"
          ? { ...(value as object), id: "occupied" }
          : value;
      return originalAdd.call(this, stored, key);
    },
  );
  await assert.rejects(commitCommand(request, [reminder, draft]));
  injected.mock.restore();
  assert.deepEqual((await loadWorkspace()).records, [occupied]);
  assert.equal((await receipts()).length, 0);
  const retry = await commitCommand(request, [reminder, draft]);
  assert.equal(retry.created, true);
  assert.equal(
    (await loadWorkspace()).records.filter(
      (record) => record.commandId === request.command_id,
    ).length,
    2,
  );
});

test("a draft-only command survives reload and a locally added contact persists", async () => {
  await commitCommand(request, [draft]);
  const contact = await addGuestContact("Jordan Lee", "jordan.lee@example.com");
  const loaded = await loadWorkspace();
  assert.equal(loaded.records.length, 1);
  assert.equal(loaded.records[0].kind, "draft");
  assert.ok(
    loaded.contacts.some(
      (entry) => entry.id === contact.id && entry.email === contact.email,
    ),
  );
  assert.equal((await receipts()).length, 1);
});

test("switching sessions before commit keeps the result and transcript with their recording", async () => {
  const a = (await loadWorkspace()).selectedSession;
  await storeTurn({
    id: request.command_id,
    createdAt: request.now,
    sessionId: a,
    transcript: request.transcript,
  });
  const { selected: b } = await selectWorkspaceSession();
  assert.notEqual(a, b);
  const {
    records: [email],
  } = await commitCommand(request, [draft], a);
  assert.equal(email.kind, "draft");
  const second = {
    ...request,
    command_id: "second",
    transcript: "Remind me to follow up.",
  };
  await storeTurn({
    id: second.command_id,
    createdAt: second.now,
    sessionId: b,
    transcript: second.transcript,
  });
  await commitCommand(second, [reminder], b);
  const replay = await commitCommand(request, [draft], b);
  assert.equal(replay.created, false);
  assert.equal(replay.records[0].sessionId, a);
  if (email.kind === "draft")
    await updateResult({ ...email, subject: "Edited subject" });
  assert.equal((await loadWorkspace()).selectedSession, b);
  await selectWorkspaceSession(a);
  const loaded = await loadWorkspace();
  assert.equal(loaded.selectedSession, a);
  assert.equal(loaded.sessions.length, 2);
  assert.deepEqual(
    loaded.records.filter((result) => result.sessionId === a),
    [{ ...email, subject: "Edited subject" }],
  );
  assert.deepEqual(
    loaded.records
      .filter((result) => result.sessionId === b)
      .map((result) => result.kind),
    ["reminder"],
  );
  assert.deepEqual(
    loaded.turns.filter((turn) => turn.sessionId === a).map((turn) => turn.id),
    [request.command_id],
  );
});
