import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseCommandResponse,
  withSelectedContact,
} from "../src/lib/command-api.ts";
import { relevantContacts, validateContact } from "../src/lib/contacts.ts";
import { recordsForCommand } from "../src/lib/reminder-store.ts";
import { request, draft, reminder } from "./fixtures/commands.ts";

// Definitions only. No live provider is contacted by these fixture cases.
const response = (actions: unknown[]) => ({
  command_id: request.command_id,
  actions,
  clarification: null,
});

test("a draft alone resolves its recipient from the request snapshot", () => {
  const parsed = parseCommandResponse(response([draft]), request);
  assert.equal(parsed.kind, "actions");
  if (parsed.kind !== "actions") return;
  const [saved] = recordsForCommand(request, parsed.actions);
  assert.equal(saved.kind, "draft");
  if (saved.kind !== "draft") return;
  assert.equal(saved.recipient, "Priya Shah");
  assert.equal(saved.to, "priya.shah@example.com");
  assert.equal(saved.subject, draft.subject);
  assert.equal(saved.body, draft.body);
});

test("draft and reminder produce distinct UI IDs under the same command", () => {
  const parsed = parseCommandResponse(response([draft, reminder]), request);
  assert.equal(parsed.kind, "actions");
  if (parsed.kind !== "actions") return;
  const saved = recordsForCommand(request, parsed.actions);
  assert.equal(saved.length, 2);
  assert.notEqual(saved[0].id, saved[1].id);
  assert.equal(saved[0].commandId, saved[1].commandId);
  assert.equal(
    saved.find((record) => record.kind === "reminder")?.id,
    request.command_id,
  );
});

test("contact selection preserves ID, transcript, original time and contacts despite later address-book changes", () => {
  const contacts = [
    ...request.contacts!.map((contact) => ({ ...contact })),
    { id: "priya-rao", name: "Priya Rao", email: "priya.rao@example.com" },
  ];
  const pending = {
    ...request,
    contacts: relevantContacts(contacts, request.transcript),
  };
  const clarification = parseCommandResponse(
    {
      command_id: request.command_id,
      actions: [],
      clarification: "Which Priya?",
      clarification_options: contacts.map((contact) => ({
        contact_id: contact.id,
        name: contact.name,
        email: contact.email,
      })),
    },
    pending,
  );
  assert.equal(clarification.kind, "clarification");
  if (clarification.kind !== "clarification") return;
  contacts[0].email = "changed@example.com";
  const selected = withSelectedContact(
    pending,
    clarification.options,
    "priya-shah",
  );
  assert.equal(selected.command_id, request.command_id);
  assert.equal(selected.transcript, request.transcript);
  assert.equal(selected.now, request.now);
  assert.equal(selected.timezone, request.timezone);
  assert.equal(selected.contacts![0].email, "priya.shah@example.com");
  assert.equal(selected.selected_contact_id, "priya-shah");
  assert.throws(() =>
    withSelectedContact(pending, clarification.options, "unknown"),
  );
  assert.throws(() =>
    parseCommandResponse(
      response([{ ...draft, to_contact_id: "priya-rao" }]),
      selected,
    ),
  );
});

test("unknown or forged contact choices and draft recipients are rejected", () => {
  assert.throws(() =>
    parseCommandResponse(
      response([{ ...draft, to_contact_id: "invented" }]),
      request,
    ),
  );
  assert.throws(() =>
    parseCommandResponse(
      {
        command_id: request.command_id,
        actions: [],
        clarification: "Which Priya?",
        clarification_options: [
          {
            contact_id: "priya-shah",
            name: "Priya Shah",
            email: "forged@example.com",
          },
        ],
      },
      request,
    ),
  );
});

test("a bad second action, mixed fields or duplicate drafts prevents the entire result", () => {
  for (const actions of [
    [draft, { ...reminder, due_at: "invalid" }],
    [draft, { ...reminder, body: "mixed fields" }],
    [draft, draft],
    [{ ...draft, body: "" }],
    [{ ...draft, body: "x".repeat(8001) }],
  ])
    assert.throws(() => parseCommandResponse(response(actions), request));
});

test("a missing recipient or time stays a zero-action clarification", () => {
  assert.deepEqual(
    parseCommandResponse(
      {
        command_id: request.command_id,
        actions: [],
        clarification: "Add the contact and record a complete revised command.",
      },
      request,
    ),
    {
      kind: "clarification",
      question: "Add the contact and record a complete revised command.",
      options: [],
    },
  );
  assert.throws(() =>
    parseCommandResponse(
      { ...response([draft]), clarification: "When should I remind you?" },
      request,
    ),
  );
});

test("contact snapshots contain only relevant plain fields and reject invalid local contact entry", () => {
  const contacts = [
    { ...request.contacts![0], sample: true },
    { id: "alex", name: "Alex Chen", email: "alex@example.com" },
  ];
  assert.deepEqual(
    relevantContacts(contacts, "Draft Priya a note."),
    request.contacts,
  );
  assert.throws(() => validateContact("", "priya@example.com"));
  assert.throws(() => validateContact("Priya", "Priya <priya@example.com>"));
});
