import type { CommandAction, CommandRequest } from "./command-api.ts";
import {
  EXAMPLE_CONTACTS,
  validateContact,
  type GuestContact,
} from "./contacts.ts";
import type {
  DraftResult,
  ReminderResult,
  WorkspaceResult,
} from "./results.ts";

type SavedMetadata = { commandId: string; createdAt: string };
export type StoredReminder = ReminderResult & SavedMetadata;
export type StoredDraft = DraftResult & SavedMetadata & { contactId: string };
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
      request = indexedDB.open("morning-guest", 2);
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
}> {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(["reminders", "drafts", "contacts"], "readonly");
    } catch {
      db.close();
      reject(new Error("Morning couldn't load saved results. Please retry."));
      return;
    }
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

export function recordsForCommand(
  request: CommandRequest,
  actions: readonly CommandAction[],
): StoredResult[] {
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
      } satisfies StoredReminder;
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
): Promise<CommitResult> {
  const proposed = recordsForCommand(request, actions);
  const db = await openStore();
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(["reminders", "drafts", "commands"], "readwrite");
    } catch {
      db.close();
      reject(storageError());
      return;
    }
    const commands = tx.objectStore("commands");
    let outcome: CommitResult | undefined;
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
          if (existing.length) {
            // Receipts and legacy records are authoritative. Never replay over
            // edits or add new actions to an already completed command.
            outcome = { records: existing, created: false };
            if (!existingReceipt)
              commands.add(receiptFor(request.command_id, existing));
          } else {
            proposed.forEach((record) =>
              tx
                .objectStore(record.kind === "draft" ? "drafts" : "reminders")
                .add(record),
            );
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
      if (outcome) resolve(outcome);
      else reject(storageError());
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(storageError());
    };
  });
}

export async function updateResult(
  result: WorkspaceResult,
): Promise<StoredResult> {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(
        result.kind === "draft" ? "drafts" : "reminders",
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
      store.put(updated);
    };
    tx.oncomplete = () => {
      db.close();
      if (updated) resolve(updated);
      else reject(storageError());
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
