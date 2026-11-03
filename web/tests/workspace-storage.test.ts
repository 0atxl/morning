import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { IDBFactory, IDBObjectStore as FakeObjectStore } from "fake-indexeddb";
import {
  addGuestContact,
  commitCommand,
  loadWorkspace,
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
beforeEach(() =>
  Object.defineProperty(globalThis, "indexedDB", {
    value: new IDBFactory(),
    writable: true,
    configurable: true,
  }),
);
afterEach(() => {
  if (originalFactory)
    Object.defineProperty(globalThis, "indexedDB", originalFactory);
  else Reflect.deleteProperty(globalThis, "indexedDB");
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
