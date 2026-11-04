import { ownerKey, type MailSchedule } from "./reminder-alerts.ts";
import type { CommandAction, CommandRequest } from "./command-api.ts";
import type { SpeechLanguage } from "./language.ts";
import {
  parseLookupResult,
  type LookupContext,
  type LookupResult,
} from "./lookup-result.ts";
import {
  EXAMPLE_CONTACTS,
  validateContact,
  type GuestContact,
} from "./contacts.ts";
import {
  nextRecurringDue,
  type DraftResult,
  type ReminderResult,
  type WorkspaceResult,
  type LookupWorkspaceResult,
  type MeetingMinutes,
  type MinutesResult,
} from "./results.ts";

export type Session = { id: string; createdAt: string };
export type Turn = {
  id: string;
  sessionId: string;
  transcript: string;
  createdAt: string;
  reply?: string;
  replyLanguage?: SpeechLanguage;
  lookup?: LookupResult;
  lookupContext?: LookupContext;
  minutes?: MeetingMinutes;
};
export const earlierActivity = "earlier-activity";

// Only completed read-only turns supply memory. Saved actions use their own
// explicit contexts and receipts; an old command must never become a new action.
export function previousTurnContext(
  turns: readonly Turn[],
  sessionId: string,
): CommandRequest["previous_turn"] {
  if (!sessionId || sessionId === earlierActivity) return;
  const previous = turns
    .filter(
      (turn) =>
        turn.sessionId === sessionId &&
        !turn.lookupContext &&
        (turn.lookup?.status === "answered" ||
          turn.minutes ||
          (!turn.lookup && turn.reply)),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (!previous) return;

  const values = {
    transcript: previous.transcript,
    topic: previous.lookup?.query ?? (previous.minutes ? "Meeting notes" : ""),
    answer: previous.lookup?.answer ?? previous.minutes?.summary ?? "",
    reply: previous.reply ?? "",
  };
  // Go validates UTF-8 bytes, including for Hindi. Do not split a code point.
  const limits = { transcript: 8192, topic: 300, answer: 4000, reply: 1000 };
  const context: NonNullable<CommandRequest["previous_turn"]> = {};
  for (const key of ["transcript", "topic", "answer", "reply"] as const) {
    const bytes = new TextEncoder().encode(values[key]);
    let end = Math.min(bytes.length, limits[key]);
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    const text = new TextDecoder().decode(bytes.subarray(0, end)).trim();
    if (text) context[key] = text;
  }
  return Object.keys(context).length ? context : undefined;
}

function newSession(): Session {
  return { id: crypto.randomUUID(), createdAt: new Date().toISOString() };
}

type SavedMetadata = {
  commandId: string;
  createdAt: string;
  sessionId?: string;
};
export type StoredReminder = ReminderResult &
  SavedMetadata & { mailRevision?: number };
export type StoredDraft = DraftResult & SavedMetadata & { contactId: string };
export type StoredLookup = LookupWorkspaceResult & SavedMetadata;
export type StoredMinutes = MinutesResult & SavedMetadata;
export type StoredResult = StoredReminder | StoredDraft;
type Receipt = { commandId: string; reminderId?: string; draftId?: string };
export type CommitResult = { records: StoredResult[]; created: boolean };

function storageError() {
  return new Error(
    "Morning couldn't save in this browser. Your transcript is still available. Please retry.",
  );
}

function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(
        new Error(
          "Browser storage isn't available. Allow local storage for Morning, then retry.",
        ),
      );
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open("morning-guest", 3);
    } catch {
      reject(
        new Error(
          "Morning couldn't open browser storage. Allow local storage, then retry.",
        ),
      );
      return;
    }
    let blocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      // Upgrade in place. Existing reminders and v1 receipts keep their keys,
      // timestamps and edits. No store is cleared or recreated.
      if (!db.objectStoreNames.contains("reminders"))
        db.createObjectStore("reminders", { keyPath: "id" });
      if (!db.objectStoreNames.contains("commands"))
        db.createObjectStore("commands", { keyPath: "commandId" });
      if (!db.objectStoreNames.contains("drafts"))
        db.createObjectStore("drafts", { keyPath: "id" });
      if (!db.objectStoreNames.contains("sessions")) {
        const first = newSession();
        db.createObjectStore("sessions", { keyPath: "id" }).add(first);
        db.createObjectStore("settings").put(first.id, "selectedSession");
        db.createObjectStore("turns", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("contacts")) {
        const contacts = db.createObjectStore("contacts", { keyPath: "id" });
        EXAMPLE_CONTACTS.forEach((contact) => contacts.add({ ...contact }));
      }
    };
    request.onblocked = () => {
      blocked = true;
      reject(
        new Error(
          "Close other Morning tabs, then retry opening browser storage.",
        ),
      );
    };
    request.onerror = () => reject(storageError());
    request.onsuccess = () => {
      if (blocked) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

export async function loadWorkspace(): Promise<{
  records: StoredResult[];
  contacts: GuestContact[];
  sessions: Session[];
  turns: Turn[];
  selectedSession: string;
}> {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(
        ["reminders", "drafts", "contacts", "sessions", "turns", "settings"],
        "readonly",
      );
    } catch {
      db.close();
      reject(new Error("Morning couldn't load saved results. Please retry."));
      return;
    }
    const sessions = tx.objectStore("sessions").getAll();
    const turns = tx.objectStore("turns").getAll();
    const selected = tx.objectStore("settings").get("selectedSession");
    const reminders = tx.objectStore("reminders").getAll();
    const drafts = tx.objectStore("drafts").getAll();
    const contacts = tx.objectStore("contacts").getAll();
    tx.oncomplete = () => {
      db.close();
      const records = [
        ...(drafts.result as StoredDraft[]),
        ...(reminders.result as StoredReminder[]),
      ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      resolve({
        records,
        sessions: (sessions.result as Session[]).sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        ),
        turns: (turns.result as Turn[]).sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        ),
        selectedSession: selected.result,
        contacts: (contacts.result as GuestContact[]).sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      });
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(new Error("Morning couldn't load saved results. Please retry."));
    };
  });
}

async function writeWorkspace(
  stores: string[],
  write: (tx: IDBTransaction) => void,
) {
  const db = await openStore();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(stores, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(storageError());
      write(tx);
    });
  } finally {
    db.close();
  }
}

// Creating and selecting an empty conversation is one durable operation.
export async function selectWorkspaceSession(id?: string) {
  const created = id === undefined ? newSession() : undefined;
  const selected = created?.id ?? id!;
  await writeWorkspace(["sessions", "settings"], (tx) => {
    if (created) tx.objectStore("sessions").add(created);
    tx.objectStore("settings").put(selected, "selectedSession");
  });
  return { selected, created };
}

export async function deleteWorkspaceSession(sessionId: string): Promise<{
  selected: string;
  created?: Session;
}> {
  let nextSelected = "";
  let createdSession: Session | undefined;

  await writeWorkspace(
    ["sessions", "turns", "reminders", "drafts", "settings"],
    (tx) => {
      const sessionsStore = tx.objectStore("sessions");
      const turnsStore = tx.objectStore("turns");
      const remindersStore = tx.objectStore("reminders");
      const draftsStore = tx.objectStore("drafts");
      const settingsStore = tx.objectStore("settings");

      sessionsStore.delete(sessionId);

      const turnsReq = turnsStore.getAll();
      turnsReq.onsuccess = () => {
        const allTurns = (turnsReq.result as Turn[]) || [];
        for (const turn of allTurns) {
          if (turn.sessionId === sessionId) {
            turnsStore.delete(turn.id);
          }
        }
      };

      const remindersReq = remindersStore.getAll();
      remindersReq.onsuccess = () => {
        const allReminders = (remindersReq.result as StoredReminder[]) || [];
        for (const rem of allReminders) {
          if (rem.sessionId === sessionId) {
            remindersStore.delete(rem.id);
          }
        }
      };

      const draftsReq = draftsStore.getAll();
      draftsReq.onsuccess = () => {
        const allDrafts = (draftsReq.result as StoredDraft[]) || [];
        for (const draft of allDrafts) {
          if (draft.sessionId === sessionId) {
            draftsStore.delete(draft.id);
          }
        }
      };

      const settingsReq = settingsStore.get("selectedSession");
      settingsReq.onsuccess = () => {
        const currentSelected = settingsReq.result as string | undefined;
        if (currentSelected === sessionId) {
          const allSessionsReq = sessionsStore.getAll();
          allSessionsReq.onsuccess = () => {
            const remaining = (allSessionsReq.result as Session[]) || [];
            if (remaining.length > 0) {
              nextSelected = remaining[remaining.length - 1].id;
            } else {
              createdSession = newSession();
              sessionsStore.add(createdSession);
              nextSelected = createdSession.id;
            }
            settingsStore.put(nextSelected, "selectedSession");
          };
        } else {
          nextSelected = currentSelected ?? "";
        }
      };
    },
  );

  signalReminderChange();
  return { selected: nextSelected, created: createdSession };
}

export async function storeTurn(turn: Turn) {
  await writeWorkspace(["turns"], (tx) => tx.objectStore("turns").put(turn));
}

// The turn itself is the lookup receipt. Answer, sources, lookup time and reply
// commit together, independently of reminder and draft stores.
export async function commitLookup(turn: Turn, snapshot: LookupResult) {
  const lookup = parseLookupResult(snapshot);
  let saved: Turn | undefined;
  let created = false;
  await writeWorkspace(["turns"], (tx) => {
    const store = tx.objectStore("turns");
    const read = store.get(turn.id);
    read.onsuccess = () => {
      const original = read.result as Turn | undefined;
      if (
        !original ||
        original.sessionId !== turn.sessionId ||
        original.transcript !== turn.transcript
      ) {
        tx.abort();
        return;
      }
      if (original.lookup) {
        saved = original;
        return;
      }
      saved = { ...original, reply: lookup.answer, lookup };
      delete saved.lookupContext;
      try {
        store.put(saved);
      } catch {
        saved = undefined;
        tx.abort();
        return;
      }
      created = true;
    };
  });
  if (!saved) throw storageError();
  return { turn: saved, created };
}

export function lookupRecord(turn: Turn): StoredLookup | null {
  if (!turn.lookup) return null;
  return {
    id: `lookup:${turn.id}`,
    commandId: turn.id,
    sessionId: turn.sessionId,
    createdAt: turn.createdAt,
    transcript: turn.transcript,
    kind: "lookup",
    title: turn.lookup.query,
    lookup: turn.lookup,
  };
}

export function minutesRecord(turn: Turn): StoredMinutes | null {
  if (!turn.minutes) return null;
  return {
    id: `minutes:${turn.id}`,
    commandId: turn.id,
    sessionId: turn.sessionId,
    createdAt: turn.createdAt,
    transcript: turn.transcript,
    kind: "minutes",
    title: "Meeting Minutes",
    minutes: turn.minutes,
  };
}

export async function commitMinutes(
  turn: Turn,
  minutes: MeetingMinutes,
): Promise<{ turn: Turn; created: boolean }> {
  const db = await openStore();
  const stored: Turn = { ...turn, minutes };
  let created = false;
  let saved: Turn | undefined;
  await new Promise<void>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(["turns", "commands"], "readwrite");
    } catch {
      db.close();
      reject(storageError());
      return;
    }
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(storageError());
    };
    const commands = tx.objectStore("commands");
    commands.get(turn.id).onsuccess = (event) => {
      const existing = (event.target as IDBRequest).result as
        | Receipt
        | undefined;
      if (!existing) {
        created = true;
        commands.add({ commandId: turn.id });
      }
      const turns = tx.objectStore("turns");
      turns.get(turn.id).onsuccess = (turnEvent) => {
        const found = (turnEvent.target as IDBRequest).result as
          | Turn
          | undefined;
        saved = found?.minutes ? found : stored;
        turns.put(saved);
      };
    };
  });
  if (!saved) throw storageError();
  return { turn: saved, created };
}

export function recordsForCommand(
  request: CommandRequest,
  actions: readonly CommandAction[],
  sessionId?: string,
): StoredResult[] {
  if (
    actions.some(
      (action) =>
        action.type === "reschedule_reminder" || action.type === "update_draft",
    )
  )
    throw new Error(
      "A correction must update its existing reminder, not create records.",
    );
  if (
    !actions.length ||
    actions.length > 2 ||
    new Set(actions.map((action) => action.type)).size !== actions.length
  )
    throw new Error(
      "A command must contain one draft, one reminder, or one of each. Nothing was saved.",
    );
  return actions.map((action) => {
    const metadata = {
      ...(sessionId ? { sessionId } : {}),
      commandId: request.command_id,
      createdAt: request.now,
      transcript: request.transcript,
    };
    if (action.type === "create_reminder")
      return {
        ...metadata,
        id: request.command_id,
        kind: "reminder",
        title: action.title,
        dueAt: action.due_at,
        timezone: request.timezone,
        ...(action.repeat ? { repeat: action.repeat } : {}),
      } satisfies StoredReminder;
    if (action.type !== "draft_email") throw storageError();
    const contact = request.contacts?.find(
      (candidate) => candidate.id === action.to_contact_id,
    );
    if (!contact)
      throw new Error(
        "The draft's recipient is missing from this command. Nothing was saved.",
      );
    return {
      ...metadata,
      id: `draft:${request.command_id}`,
      kind: "draft",
      title: `Draft to ${contact.name}`,
      contactId: contact.id,
      recipient: contact.name,
      to: contact.email,
      subject: action.subject,
      body: action.body,
    } satisfies StoredDraft;
  });
}

function receiptFor(
  commandId: string,
  records: readonly StoredResult[],
): Receipt {
  const reminder = records.find((record) => record.kind === "reminder");
  const draft = records.find((record) => record.kind === "draft");
  return {
    commandId,
    ...(reminder ? { reminderId: reminder.id } : {}),
    ...(draft ? { draftId: draft.id } : {}),
  };
}

export async function commitCommand(
  request: CommandRequest,
  actions: readonly CommandAction[],
  sessionId?: string,
): Promise<CommitResult> {
  const correction =
    actions.length === 1 && actions[0].type === "reschedule_reminder"
      ? actions[0]
      : undefined;
  const draftUpdate =
    actions.length === 1 && actions[0].type === "update_draft"
      ? actions[0]
      : undefined;
  if (
    draftUpdate &&
    (request.draft_context?.id !== draftUpdate.draft_id ||
      (request.selected_draft_id &&
        request.selected_draft_id !== draftUpdate.draft_id) ||
      !draftUpdate.subject.trim() ||
      !draftUpdate.body.trim())
  )
    throw new Error(
      "This update has no matching saved draft. Nothing was changed.",
    );
  if (
    correction &&
    (request.reminder_context?.id !== correction.reminder_id ||
      (request.selected_reminder_id &&
        request.selected_reminder_id !== correction.reminder_id) ||
      !Number.isFinite(Date.parse(correction.due_at)) ||
      Date.parse(correction.due_at) <= Date.parse(request.now))
  )
    throw new Error(
      "This correction has no matching saved reminder or valid future time. Nothing was changed.",
    );
  const proposed =
    correction || draftUpdate
      ? []
      : recordsForCommand(request, actions, sessionId);
  const db = await openStore();
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(
        ["reminders", "drafts", "commands", "settings"],
        "readwrite",
      );
    } catch {
      db.close();
      reject(storageError());
      return;
    }
    const commands = tx.objectStore("commands");
    let outcome: CommitResult | undefined;
    let failure: Error | undefined;
    const receipt = commands.get(request.command_id);
    receipt.onsuccess = () => {
      const existingReceipt = receipt.result as Receipt | undefined;
      const references = existingReceipt
        ? [
            existingReceipt.reminderId && {
              store: "reminders",
              id: existingReceipt.reminderId,
            },
            existingReceipt.draftId && {
              store: "drafts",
              id: existingReceipt.draftId,
            },
          ].filter((entry): entry is { store: string; id: string } =>
            Boolean(entry),
          )
        : draftUpdate
          ? [{ store: "drafts", id: draftUpdate.draft_id }]
          : correction
            ? [{ store: "reminders", id: correction.reminder_id }]
            : [
                { store: "reminders", id: request.command_id },
                { store: "drafts", id: `draft:${request.command_id}` },
              ];
      if (!references.length) {
        tx.abort();
        return;
      }
      const existing: StoredResult[] = [];
      let remaining = references.length;
      references.forEach(({ store, id }) => {
        const lookup = tx.objectStore(store).get(id);
        lookup.onsuccess = () => {
          if (lookup.result) existing.push(lookup.result as StoredResult);
          else if (existingReceipt) {
            tx.abort();
            return;
          }
          if (--remaining) return;
          if (correction && !existingReceipt) {
            const original = existing[0];
            if (
              !original ||
              original.kind !== "reminder" ||
              original.sessionId !== sessionId ||
              Date.parse(original.dueAt) !==
                Date.parse(request.reminder_context!.due_at)
            ) {
              failure = new Error(
                "This reminder changed or is outside this conversation. Record the correction again. Nothing was changed.",
              );
              tx.abort();
              return;
            }
            const updated: StoredReminder = {
              ...original,
              dueAt: correction.due_at,
              timezone: request.timezone,
              ...(correction.repeat ? { repeat: correction.repeat } : {}),
            };
            queueOwnerMail(tx, updated);
            tx.objectStore("reminders").put(updated);
            commands.add(receiptFor(request.command_id, [updated]));
            // created means this command receipt was committed for the first time.
            outcome = { records: [updated], created: true };
          } else if (draftUpdate && !existingReceipt) {
            const original = existing[0];
            const snapshot = request.draft_context!;
            if (
              !original ||
              original.kind !== "draft" ||
              original.sessionId !== sessionId ||
              original.subject !== snapshot.subject ||
              original.body !== snapshot.body ||
              original.to !== snapshot.to
            ) {
              failure = new Error(
                "This draft changed or is outside this conversation. Record the edit again. Nothing was changed.",
              );
              tx.abort();
              return;
            }
            const updated: StoredDraft = {
              ...original,
              subject: draftUpdate.subject,
              body: draftUpdate.body,
            };
            tx.objectStore("drafts").put(updated);
            commands.add(receiptFor(request.command_id, [updated]));
            outcome = { records: [updated], created: true };
          } else if (existing.length) {
            // Receipts and legacy records are authoritative. Never replay over
            // edits or add new actions to an already completed command.
            outcome = { records: existing, created: false };
            if (!existingReceipt)
              commands.add(receiptFor(request.command_id, existing));
          } else {
            proposed.forEach((record) => {
              if (record.kind === "reminder") queueOwnerMail(tx, record);
              tx.objectStore(
                record.kind === "draft" ? "drafts" : "reminders",
              ).add(record);
            });
            commands.add(receiptFor(request.command_id, proposed));
            outcome = { records: proposed, created: true };
          }
        };
      });
    };
    // A successful individual add is not a commit. A draft, reminder and receipt
    // either all complete or all abort before rendering or speaking success.
    tx.oncomplete = () => {
      db.close();
      if (outcome) {
        if (
          outcome.created &&
          outcome.records.some((r) => r.kind === "reminder")
        )
          signalReminderChange();
        resolve(outcome);
      } else reject(storageError());
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(failure ?? storageError());
    };
  });
}

export async function addManualReminder(
  title: string,
  dueAt: string,
  sessionId: string,
): Promise<StoredReminder> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const reminder: StoredReminder = {
    id,
    kind: "reminder",
    title,
    transcript: "",
    dueAt,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    commandId: id,
    createdAt: now,
    sessionId,
  };
  await writeWorkspace(["reminders", "settings"], (tx) => {
    queueOwnerMail(tx, reminder);
    tx.objectStore("reminders").add(reminder);
  });
  signalReminderChange();
  return reminder;
}

export async function updateResult(
  result: WorkspaceResult,
): Promise<StoredResult> {
  if (result.kind === "lookup")
    throw new Error(
      "A saved lookup is read-only. Record a new question for fresh information.",
    );
  const db = await openStore();
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(
        result.kind === "draft" ? ["drafts"] : ["reminders", "settings"],
        "readwrite",
      );
    } catch {
      db.close();
      reject(storageError());
      return;
    }
    const store = tx.objectStore(
      result.kind === "draft" ? "drafts" : "reminders",
    );
    const request = store.get(result.id);
    let updated: StoredResult | undefined;
    request.onsuccess = () => {
      const original = request.result as StoredResult | undefined;
      if (!original || original.kind !== result.kind) {
        tx.abort();
        return;
      }
      updated = {
        ...original,
        ...result,
        id: original.id,
        commandId: original.commandId,
        createdAt: original.createdAt,
      } as StoredResult;
      if (updated.kind === "reminder" && original.kind === "reminder") {
        updated.mailRevision = original.mailRevision;
        if (
          original.title !== updated.title ||
          original.dueAt !== updated.dueAt
        )
          queueOwnerMail(tx, updated);
      }
      store.put(updated);
    };
    tx.oncomplete = () => {
      db.close();
      if (updated) {
        if (updated.kind === "reminder") signalReminderChange();
        resolve(updated);
      } else reject(storageError());
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(storageError());
    };
  });
}

export async function addGuestContact(
  name: string,
  email: string,
): Promise<GuestContact> {
  name = name.trim();
  email = email.trim();
  validateContact(name, email);
  const db = await openStore();
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction("contacts", "readwrite");
    } catch {
      db.close();
      reject(new Error("Couldn't save this contact. Please retry."));
      return;
    }
    const store = tx.objectStore("contacts");
    const request = store.getAll();
    let saved: GuestContact | undefined;
    let message = "Couldn't save this contact. Please retry.";
    request.onsuccess = () => {
      const contacts = request.result as GuestContact[];
      saved = contacts.find(
        (contact) =>
          contact.name.toLocaleLowerCase() === name.toLocaleLowerCase() &&
          contact.email.toLocaleLowerCase() === email.toLocaleLowerCase(),
      );
      if (saved) return;
      if (contacts.length >= 20) {
        message = "This guest address book supports up to 20 contacts.";
        tx.abort();
        return;
      }
      saved = { id: crypto.randomUUID(), name, email };
      store.add(saved);
    };
    tx.oncomplete = () => {
      db.close();
      if (saved) resolve(saved);
      else reject(new Error(message));
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(new Error(message));
    };
  });
}

function signalReminderChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("morning-reminder-change"));
  try {
    window.localStorage.setItem("morning.reminder-change", crypto.randomUUID());
  } catch {
    // Same-tab events and periodic polling still work without localStorage.
  }
}

function queueOwnerMail(tx: IDBTransaction, reminder: StoredReminder) {
  if (!ownerKey()) return;
  reminder.mailRevision = Math.max(
    Date.now(),
    (reminder.mailRevision ?? 0) + 1,
  );
  const mail: MailSchedule = {
    id: reminder.id,
    title: reminder.title,
    dueAt: reminder.dueAt,
    revision: reminder.mailRevision,
  };
  tx.objectStore("settings").put(mail, "mail:" + reminder.id);
}

export async function acknowledgeReminderMail(job: MailSchedule) {
  await writeWorkspace(["settings"], (tx) => {
    const store = tx.objectStore("settings");
    const key = "mail:" + job.id;
    const read = store.get(key);
    read.onsuccess = () => {
      if (read.result?.revision === job.revision) store.delete(key);
    };
  });
  signalReminderChange();
}

// Alerts remain pending until dismissed. Only an eligible foreground tab may
// claim a chime; the timestamp also covers edits that reschedule a reminder.
export async function pollReminders(now: number, canRing = () => false) {
  const due: StoredReminder[] = [];
  const ring: StoredReminder[] = [];
  let next = now + 60_000;
  let pending: MailSchedule[] = [];
  let hasMail = false;
  await writeWorkspace(["reminders", "settings"], (tx) => {
    const settings = tx.objectStore("settings");
    const mail = settings.getAll(IDBKeyRange.bound("mail:", "mail;"));
    mail.onsuccess = () => {
      pending = mail.result as MailSchedule[];
    };
    const records = tx.objectStore("reminders").getAll();
    records.onsuccess = () => {
      for (const record of records.result as StoredReminder[]) {
        if (record.mailRevision) hasMail = true;
        const time = Date.parse(record.dueAt);
        if (!Number.isFinite(time)) continue;
        if (time > now) {
          next = Math.min(next, time);
          continue;
        }
        const dismissed = settings.get("dismissed:" + record.id);
        dismissed.onsuccess = () => {
          if (dismissed.result === time) return;
          due.push(record);
          const key = "rang:" + record.id;
          const previous = settings.get(key);
          previous.onsuccess = () => {
            if (previous.result === time || !canRing()) return;
            settings.put(time, key);
            ring.push(record);
          };
        };
      }
    };
  });
  return { due, ring, next, pending, hasMail };
}

export async function dismissReminderAlerts(alerts: readonly StoredReminder[]) {
  await writeWorkspace(["reminders", "settings"], (tx) => {
    for (const reminder of alerts) {
      tx.objectStore("settings").put(
        Date.parse(reminder.dueAt),
        "dismissed:" + reminder.id,
      );
      if (reminder.repeat) {
        const nextDue = nextRecurringDue(reminder.dueAt, reminder.repeat);
        const updated: StoredReminder = {
          ...reminder,
          dueAt: nextDue,
        };
        queueOwnerMail(tx, updated);
        tx.objectStore("reminders").put(updated);
      }
    }
  });
  signalReminderChange();
}
