import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  IDBFactory,
  IDBKeyRange as FakeKeyRange,
  IDBObjectStore as FakeObjectStore,
} from "fake-indexeddb";
import { RequestError } from "../src/lib/command-api.ts";
import type { SpeechLanguage } from "../src/lib/language.ts";
import {
  confirmedReminderInstant,
  maxMinutesBody,
  maxMinutesItems,
  meetingCommand,
  minutesRequest,
  minutesSpeech,
  parseMeetingMinutes,
  requestMeetingMinutes,
} from "../src/lib/minutes.ts";
import {
  addManualReminder,
  commitMinutes,
  createMinutesReminder,
  deleteWorkspaceSession,
  loadWorkspace,
  minutesRecord,
  selectWorkspaceSession,
  storeMinutesInput,
  updateMinutes,
  type Turn,
} from "../src/lib/reminder-store.ts";
import {
  downloadResult,
  minutesComposeUrl,
  resultText,
  type MeetingMinutes,
  type MinutesResult,
} from "../src/lib/results.ts";

// Definitions only. An approved run uses in-memory IndexedDB and stubbed I/O.
// Direct API fixtures do not mount useReminderFlow or exercise dialog lifecycle.
const originalFactory = Object.getOwnPropertyDescriptor(
  globalThis,
  "indexedDB",
);
const originalKeyRange = Object.getOwnPropertyDescriptor(
  globalThis,
  "IDBKeyRange",
);
function restoreGlobal(
  name: string,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
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
  restoreGlobal("indexedDB", originalFactory);
  restoreGlobal("IDBKeyRange", originalKeyRange);
});

const futureInstant = "2099-06-15T09:30:00+00:00";
function fixture(): MeetingMinutes {
  return {
    summary: "The team agreed to revise the release timeline.",
    decisions: ["Review the revised timeline before release."],
    action_items: [
      {
        task: "Ask Priya to review the timeline",
        owner: "Priya",
        deadline: "Friday",
      },
      { task: "Confirm the review date", owner: null, deadline: null },
    ],
    open_questions: ["Who will approve the release?"],
  };
}
function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
async function inputTurn(
  id = "meeting-turn",
  transcript = "The team discussed the release timeline.",
): Promise<Turn> {
  const workspace = await loadWorkspace();
  const turn: Turn = {
    id,
    sessionId: workspace.selectedSession,
    createdAt: "2030-01-15T09:00:00.000Z",
    transcript,
  };
  await storeMinutesInput(turn);
  return turn;
}
async function reopenedTurn(id: string) {
  const turn = (await loadWorkspace()).turns.find((entry) => entry.id === id);
  assert.ok(turn, `Expected saved turn ${id}`);
  return turn;
}
function resultFor(turn: Turn): MinutesResult {
  const result = minutesRecord(turn);
  assert.ok(result);
  return result;
}
function storedRows(store: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("morning-guest");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(store, "readonly");
      const read = tx.objectStore(store).getAll();
      tx.oncomplete = () => {
        db.close();
        resolve(read.result);
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}
async function assertNoActions() {
  assert.deepEqual((await loadWorkspace()).records, []);
  assert.deepEqual(await storedRows("commands"), []);
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("minutes accept only the direct four-field response and preserve explicit nulls", () => {
  const value = fixture();
  assert.deepEqual(parseMeetingMinutes(value), value);
  assert.deepEqual(
    parseMeetingMinutes({
      summary: "No actions were agreed.",
      decisions: [],
      action_items: [],
      open_questions: [],
    }),
    {
      summary: "No actions were agreed.",
      decisions: [],
      action_items: [],
      open_questions: [],
    },
  );
  for (const key of [
    "summary",
    "decisions",
    "action_items",
    "open_questions",
  ]) {
    const missing: Record<string, unknown> = { ...value };
    delete missing[key];
    assert.throws(() => parseMeetingMinutes(missing), RequestError, key);
  }
  for (const key of ["task", "owner", "deadline"]) {
    const missing: Record<string, unknown> = { ...value.action_items[0] };
    delete missing[key];
    assert.throws(
      () => parseMeetingMinutes({ ...value, action_items: [missing] }),
      RequestError,
      key,
    );
  }
  for (const response of [
    null,
    [],
    JSON.stringify(value),
    { minutes: value },
    { ...value, extra: "ignored?" },
    { ...value, summary: 42 },
    { ...value, decisions: null },
    { ...value, action_items: {} },
    { ...value, open_questions: "Who?" },
    { ...value, decisions: [false] },
    { ...value, open_questions: [null] },
    { ...value, action_items: [null] },
    { ...value, action_items: ["Do this"] },
    {
      ...value,
      action_items: [{ task: "Review", owner: undefined, deadline: null }],
    },
    {
      ...value,
      action_items: [{ task: "Review", owner: null, deadline: 123 }],
    },
    {
      ...value,
      action_items: [
        { task: "Review", owner: null, deadline: null, id: "provider-id" },
      ],
    },
  ])
    assert.throws(() => parseMeetingMinutes(response), RequestError);
});

test("command envelopes and actions cannot be mixed into minutes", () => {
  const value = fixture();
  const action = {
    type: "create_reminder",
    title: "Send slides",
    due_at: futureInstant,
  };
  for (const response of [
    { ...value, actions: [] },
    { ...value, actions: [action] },
    {
      command_id: "meeting-turn",
      actions: [action],
      clarification: null,
      minutes: value,
    },
    { ...value, action_items: [action] },
    {
      ...value,
      action_items: [{ ...value.action_items[0], type: "draft_email" }],
    },
    {
      ...value,
      action_items: [{ ...value.action_items[0], reminderId: "injected" }],
    },
  ])
    assert.throws(() => parseMeetingMinutes(response), RequestError);
});

test("all minutes text fields enforce their Unicode scalar limits and single-line text", () => {
  const fields: {
    name: string;
    limit: number;
    nullable?: boolean;
    withText: (value: unknown) => unknown;
  }[] = [
    {
      name: "summary",
      limit: 800,
      withText: (summary) => ({ ...fixture(), summary }),
    },
    {
      name: "decision",
      limit: 500,
      withText: (value) => ({ ...fixture(), decisions: [value] }),
    },
    {
      name: "task",
      limit: 500,
      withText: (task) => ({
        ...fixture(),
        action_items: [{ task, owner: null, deadline: null }],
      }),
    },
    {
      name: "owner",
      limit: 200,
      nullable: true,
      withText: (owner) => ({
        ...fixture(),
        action_items: [{ task: "Review", owner, deadline: null }],
      }),
    },
    {
      name: "deadline",
      limit: 200,
      nullable: true,
      withText: (deadline) => ({
        ...fixture(),
        action_items: [{ task: "Review", owner: null, deadline }],
      }),
    },
    {
      name: "question",
      limit: 500,
      withText: (value) => ({ ...fixture(), open_questions: [value] }),
    },
  ];
  for (const field of fields) {
    assert.doesNotThrow(
      () => parseMeetingMinutes(field.withText("😀".repeat(field.limit))),
      field.name,
    );
    assert.throws(
      () => parseMeetingMinutes(field.withText("😀".repeat(field.limit + 1))),
      RequestError,
      field.name,
    );
    for (const invalid of [
      "",
      " ",
      " leading",
      "trailing ",
      "a\nb",
      "a\rb",
      "a\tb",
      "a\u0000b",
      "a\u007fb",
      "a\u2028b",
      "a\u2029b",
      1,
      {},
    ]) {
      assert.throws(
        () => parseMeetingMinutes(field.withText(invalid)),
        RequestError,
        field.name,
      );
    }
    if (!field.nullable)
      assert.throws(
        () => parseMeetingMinutes(field.withText(null)),
        RequestError,
      );
  }
  const unicode = {
    summary: "बैठक में समय सीमा तय हुई। 😀 Cafe\u0301",
    decisions: ["हिंदी में समीक्षा करें।"],
    action_items: [
      {
        task: "स्लाइड साझा करें 😀",
        owner: "प्रिया",
        deadline: "अगले शुक्रवार",
      },
    ],
    open_questions: ["अनुमोदन कौन करेगा?"],
  };
  assert.deepEqual(parseMeetingMinutes(unicode), unicode);
});

test("each minutes array accepts twenty entries but rejects twenty-one", () => {
  assert.equal(maxMinutesItems, 20);
  for (const section of [
    "decisions",
    "action_items",
    "open_questions",
  ] as const) {
    const entries = Array.from({ length: 20 }, (_, index) =>
      section === "action_items"
        ? { task: `Review ${index}`, owner: null, deadline: null }
        : `Review ${index}`,
    );
    assert.doesNotThrow(() =>
      parseMeetingMinutes({ ...fixture(), [section]: entries }),
    );
    assert.throws(
      () =>
        parseMeetingMinutes({
          ...fixture(),
          [section]: [...entries, entries[0]],
        }),
      RequestError,
    );
  }
});

test("request limits count the complete UTF-8 JSON body, including Hindi and escaping", () => {
  assert.equal(maxMinutesBody, 64 * 1024);
  const encoder = new TextEncoder();
  for (const language of ["en", "hi"] as const) {
    const overhead = encoder.encode(
      JSON.stringify({ transcript: "", language }),
    ).byteLength;
    for (const unit of ["x", "हिंदी", "😀", '"', "\\", "\n", "\u0000"]) {
      const width = encoder.encode(JSON.stringify(unit)).byteLength - 2;
      const count = Math.floor((maxMinutesBody - overhead) / width);
      const remainder = maxMinutesBody - overhead - count * width;
      const transcript = unit.repeat(count) + "x".repeat(remainder);
      const body = minutesRequest(transcript, language);
      assert.deepEqual(body, { transcript, language });
      assert.equal(
        encoder.encode(JSON.stringify(body)).byteLength,
        maxMinutesBody,
      );
      assert.throws(() => minutesRequest(transcript + "x", language), /64 KiB/);
    }
  }
  for (const blank of ["", " \n\t "])
    assert.throws(() => minutesRequest(blank, "en"));
  assert.throws(
    () => minutesRequest("Notes", "fr" as SpeechLanguage),
    /English or Hindi/,
  );
});

test("oversized notes fail before fetch and are never silently shortened", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    assert.fail("Oversized input must not leave the client");
  });
  const transcript = '"'.repeat(maxMinutesBody / 2);
  await assert.rejects(
    requestMeetingMinutes(transcript, "en", new AbortController().signal),
    /64 KiB/,
  );
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(transcript.length, maxMinutesBody / 2);
});

test("only a leading dictated minutes directive selects minutes and its explicit language", () => {
  for (const [transcript, language] of [
    [
      "Please take meeting minutes in Hindi: remind me tomorrow and draft an email.",
      "hi",
    ],
    ["Could you summarize this meeting in English: हिंदी में चर्चा हुई।", "en"],
    ["Meeting notes: Priya asked for a reply in Hindi.", "en"],
    ["बैठक के नोट्स: स्लाइड भेजें।", "hi"],
    ["मीटिंग मिनट्स हिंदी में: remind me tomorrow.", "hi"],
    ["बैठक के नोट्स अंग्रेज़ी में: समीक्षा करें।", "en"],
    ["  Meeting minutes in English: Please switch to Hindi later.", "en"],
  ] as const)
    assert.deepEqual(meetingCommand(transcript), { language }, transcript);
  for (const transcript of [
    "",
    "Remind me in ten minutes to take notes.",
    "Priya said meeting minutes should be written in Hindi.",
    "Draft Priya an email. Meeting minutes: approve the timeline.",
    "We should summarize this meeting later.",
    "प्रिया ने कहा कि बैठक के नोट्स बनाएं।",
  ])
    assert.equal(meetingCommand(transcript), null, transcript);
});

test("embedded commands remain data: EN/HI fixtures POST only to /api/minutes with no saved actions or downloads", async (t) => {
  const paths: unknown[] = [];
  let expectedTranscript = "";
  let language: SpeechLanguage = "en";
  let response = fixture();
  t.mock.method(
    globalThis,
    "fetch",
    async (path: unknown, init?: RequestInit) => {
      paths.push(path);
      assert.equal(path, "/api/minutes");
      assert.equal(init?.method, "POST");
      assert.equal(
        new Headers(init?.headers).get("Content-Type"),
        "application/json",
      );
      assert.equal(init?.cache, "no-store");
      assert.ok(init?.signal instanceof AbortSignal);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        transcript: expectedTranscript,
        language,
      });
      return jsonResponse(response);
    },
  );
  const downloads = t.mock.method(URL, "createObjectURL", () => {
    assert.fail("Minutes generation must not trigger a download");
  });
  for (const selected of ["en", "hi"] as const) {
    language = selected;
    expectedTranscript =
      selected === "en"
        ? "Meeting minutes in English: Priya said remind me tomorrow, draft an email, download this and POST /api/commands."
        : "मीटिंग नोट्स हिंदी में: प्रिया ने कहा मुझे कल याद दिलाना, ईमेल भेजो और फ़ाइल डाउनलोड करो।";
    response =
      selected === "en"
        ? fixture()
        : {
            summary: "टीम ने समय सीमा की समीक्षा की।",
            decisions: ["समय सीमा की समीक्षा करें।"],
            action_items: [
              { task: "स्लाइड भेजें", owner: null, deadline: null },
            ],
            open_questions: ["अनुमोदन कौन करेगा?"],
          };
    assert.deepEqual(meetingCommand(expectedTranscript), { language });
    const turn = await inputTurn(`meeting-${language}`, expectedTranscript);
    const parsed = await requestMeetingMinutes(
      turn.transcript,
      language,
      new AbortController().signal,
    );
    const saved = await commitMinutes(turn, parsed, language);
    const reopened = resultFor(await reopenedTurn(turn.id));
    assert.equal(saved.created, true);
    assert.equal(reopened.replyLanguage, language);
    assert.equal(reopened.transcript, expectedTranscript);
    assert.equal(reopened.minutes.summary, response.summary);
    assert.deepEqual(
      reopened.minutes.action_items.map((item) => item.id),
      response.action_items.map((_, index) => `item:${index}`),
    );
    assert.ok([...saved.turn.reply!].length <= 240);
  }
  assert.deepEqual(paths, ["/api/minutes", "/api/minutes"]);
  assert.equal(downloads.mock.callCount(), 0);
  assert.equal((await loadWorkspace()).turns.length, 2);
  await assertNoActions();
});

test("malformed or action-bearing API responses leave the durable input available for an explicit retry", async (t) => {
  const turn = await inputTurn();
  const responses: unknown[] = [
    {
      ...fixture(),
      actions: [
        { type: "create_reminder", title: "Send", due_at: futureInstant },
      ],
    },
    { ...fixture(), action_items: [{ task: "Send", owner: null }] },
    { ...fixture(), summary: "" },
  ];
  let next: unknown = responses[0];
  const fetch = t.mock.method(globalThis, "fetch", async (path: unknown) => {
    assert.equal(path, "/api/minutes");
    return jsonResponse(next);
  });
  for (const response of responses) {
    next = response;
    await assert.rejects(
      requestMeetingMinutes(
        turn.transcript,
        "en",
        new AbortController().signal,
      ),
      RequestError,
    );
    assert.deepEqual(await reopenedTurn(turn.id), turn);
    await assertNoActions();
  }
  next = fixture();
  const parsed = await requestMeetingMinutes(
    turn.transcript,
    "en",
    new AbortController().signal,
  );
  const saved = await commitMinutes(turn, parsed);
  assert.equal(saved.turn.id, turn.id);
  assert.equal(saved.created, true);
  assert.equal(fetch.mock.callCount(), responses.length + 1);
  assert.equal((await loadWorkspace()).turns.length, 1);
});

test("a provider error preserves the input and a later retry uses the same turn", async (t) => {
  const turn = await inputTurn();
  let failed = true;
  t.mock.method(globalThis, "fetch", async (path: unknown) => {
    assert.equal(path, "/api/minutes");
    return failed
      ? jsonResponse(
          { error: { message: "Fixture provider unavailable" } },
          503,
        )
      : jsonResponse(fixture());
  });
  await assert.rejects(
    requestMeetingMinutes(turn.transcript, "en", new AbortController().signal),
    /Fixture provider unavailable/,
  );
  assert.deepEqual(await reopenedTurn(turn.id), turn);
  await assertNoActions();
  failed = false;
  const parsed = await requestMeetingMinutes(
    turn.transcript,
    "en",
    new AbortController().signal,
  );
  assert.equal((await commitMinutes(turn, parsed)).turn.id, turn.id);
  assert.equal((await loadWorkspace()).turns.length, 1);
});

test("minutes speech keeps short Unicode text and bounds complete sentences or a language-specific fallback to 240 scalars", () => {
  const english = "The timeline was approved.";
  const hindi = "समय सीमा तय हो गई।";
  assert.equal(minutesSpeech(english, "en"), english);
  assert.equal(minutesSpeech(hindi, "hi"), hindi);
  assert.equal(minutesSpeech("😀".repeat(240), "en"), "😀".repeat(240));
  assert.equal(minutesSpeech(`${english} ${"x".repeat(300)}`, "en"), english);
  assert.equal(minutesSpeech(`${hindi} ${"ह".repeat(300)}`, "hi"), hindi);
  for (const language of ["en", "hi"] as const) {
    const speech = minutesSpeech("😀".repeat(241), language);
    assert.ok([...speech].length <= 240);
    assert.match(
      speech,
      language === "hi" ? /मिनट्स सेव/ : /minutes are saved/,
    );
    assert.equal(speech.includes("\ufffd"), false);
  }
});

test("input storage is insert-if-absent and minutes require the matching durable input", async () => {
  const workspace = await loadWorkspace();
  const missing: Turn = {
    id: "not-yet-stored",
    sessionId: workspace.selectedSession,
    transcript: "Keep these original notes.",
    createdAt: "2030-01-15T09:00:00.000Z",
  };
  assert.equal(minutesRecord(missing), null);
  await assert.rejects(commitMinutes(missing, fixture()));
  assert.deepEqual((await loadWorkspace()).turns, []);
  await storeMinutesInput(missing);
  await storeMinutesInput({
    ...missing,
    createdAt: "2031-01-15T09:00:00.000Z",
  });
  assert.deepEqual(await reopenedTurn(missing.id), missing);
  await assert.rejects(
    storeMinutesInput({ ...missing, transcript: "Different notes" }),
  );
  await assert.rejects(
    commitMinutes({ ...missing, transcript: "Different notes" }, fixture()),
  );
  const saved = await commitMinutes(missing, fixture());
  await storeMinutesInput(missing);
  assert.deepEqual(await reopenedTurn(missing.id), saved.turn);
  assert.equal(resultFor(saved.turn).replyLanguage, "en");
  assert.equal(resultFor(saved.turn).id, `minutes:${missing.id}`);
  await assertNoActions();
});

test("concurrent saves, reload and reopening replay the first receipt without overwriting edits", async () => {
  const turn = await inputTurn();
  const attempts = await Promise.all([
    commitMinutes(turn, fixture()),
    commitMinutes(turn, fixture()),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.created).length, 1);
  assert.deepEqual(attempts[0].turn, attempts[1].turn);
  const result = resultFor(await reopenedTurn(turn.id));
  assert.deepEqual(
    result.minutes.action_items.map((item) => item.id),
    ["item:0", "item:1"],
  );
  const edited = await updateMinutes(
    {
      ...result,
      minutes: { ...result.minutes, summary: "The user edited this summary." },
    },
    turn.sessionId,
  );
  await storeMinutesInput(turn);
  const replay = await commitMinutes(
    turn,
    { ...fixture(), summary: "A later provider response." },
    "hi",
  );
  assert.equal(replay.created, false);
  assert.deepEqual(replay.turn, edited);
  assert.deepEqual(await reopenedTurn(turn.id), edited);
  assert.equal((await loadWorkspace()).turns.length, 1);
  await assertNoActions();
});

test("a failed minutes write retains the input and a cached-response retry keeps stable turn and item IDs", async (t) => {
  const turn = await inputTurn();
  const fetch = t.mock.method(globalThis, "fetch", async (path: unknown) => {
    assert.equal(path, "/api/minutes");
    return jsonResponse(fixture());
  });
  const parsed = await requestMeetingMinutes(
    turn.transcript,
    "hi",
    new AbortController().signal,
  );
  const originalPut = FakeObjectStore.prototype.put;
  const originalAdd = FakeObjectStore.prototype.add;
  const write = t.mock.method(
    FakeObjectStore.prototype,
    "put",
    function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      // Duplicate the existing turn key to fail an IDB request, not an event callback.
      if (this.name === "turns" && (value as Turn).minutes)
        return originalAdd.call(this, value, key);
      return originalPut.call(this, value, key);
    },
  );
  await assert.rejects(commitMinutes(turn, parsed, "hi"));
  write.mock.restore();
  assert.deepEqual(await reopenedTurn(turn.id), turn);
  await assertNoActions();
  const retry = await commitMinutes(turn, parsed, "hi");
  assert.equal(retry.created, true);
  assert.equal(retry.turn.id, turn.id);
  assert.equal(retry.turn.replyLanguage, "hi");
  assert.deepEqual(
    resultFor(retry.turn).minutes.action_items.map((item) => item.id),
    ["item:0", "item:1"],
  );
  assert.equal((await commitMinutes(turn, parsed, "hi")).created, false);
  assert.equal(
    fetch.mock.callCount(),
    1,
    "This fixture reuses a parsed response; it does not verify hook caching",
  );
  assert.equal((await loadWorkspace()).turns.length, 1);
});

test("edits to every section persist and feed text, compose and the stubbed .txt download", async (t) => {
  const turn = await inputTurn();
  const result = resultFor((await commitMinutes(turn, fixture(), "hi")).turn);
  const saved = await updateMinutes(
    {
      ...result,
      minutes: {
        summary: "समीक्षा पूरी हुई। 😀",
        decisions: ["सुधारी गई समय सीमा अपनाएं।"],
        action_items: [
          {
            ...result.minutes.action_items[0],
            task: "संशोधित स्लाइड भेजें",
            owner: "मीरा",
            deadline: "तय नहीं",
          },
        ],
        open_questions: ["अगली समीक्षा कब होगी?"],
      },
    },
    turn.sessionId,
  );
  const reopened = resultFor(await reopenedTurn(turn.id));
  assert.deepEqual(reopened, resultFor(saved));
  assert.equal(reopened.replyLanguage, "hi");
  assert.equal(saved.reply, reopened.minutes.summary);
  assert.equal(reopened.minutes.action_items[0].id, "item:0");
  const text = resultText(reopened);
  for (const expected of [
    "SUMMARY\nसमीक्षा पूरी हुई। 😀",
    "DECISIONS\n• सुधारी गई समय सीमा अपनाएं।",
    "ACTION ITEMS\n• संशोधित स्लाइड भेजें (Owner: मीरा) [Deadline: तय नहीं]",
    "OPEN QUESTIONS\n• अगली समीक्षा कब होगी?",
    `TRANSCRIPT\n${turn.transcript}`,
  ])
    assert.ok(text.includes(expected), expected);
  assert.equal(text.includes(fixture().summary), false);
  const compose = new URL(minutesComposeUrl(reopened.minutes));
  assert.equal(compose.origin, "https://mail.google.com");
  assert.equal(
    compose.searchParams.get("su"),
    `Meeting Minutes: ${reopened.minutes.summary.slice(0, 60)}`,
  );
  assert.equal(
    compose.searchParams.get("body"),
    resultText({ ...reopened, transcript: "" }),
  );

  let downloaded: Blob | undefined;
  const create = t.mock.method(URL, "createObjectURL", (blob: Blob) => {
    downloaded = blob;
    return "blob:minutes-fixture";
  });
  const revoke = t.mock.method(URL, "revokeObjectURL", (url: string) => {
    assert.equal(url, "blob:minutes-fixture");
  });
  let clicked = 0;
  let removed = 0;
  let appended = 0;
  const link = {
    href: "",
    download: "",
    click: () => {
      clicked++;
    },
    remove: () => {
      removed++;
    },
  };
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: (tag: string) => {
        assert.equal(tag, "a");
        return link;
      },
      body: {
        append: (element: unknown) => {
          assert.equal(element, link);
          appended++;
        },
      },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout: (callback: () => void, delay: number) => {
        assert.equal(delay, 1000);
        callback();
        return 0;
      },
    },
  });
  try {
    downloadResult(reopened);
    assert.ok(downloaded);
    assert.equal(downloaded.type, "text/plain;charset=utf-8");
    assert.equal(await downloaded.text(), text);
    assert.equal(link.href, "blob:minutes-fixture");
    assert.equal(link.download, "meeting-minutes.txt");
    assert.equal(appended, 1);
    assert.equal(clicked, 1);
    assert.equal(removed, 1);
    assert.equal(create.mock.callCount(), 1);
    assert.equal(revoke.mock.callCount(), 1);
  } finally {
    restoreGlobal("document", originalDocument);
    restoreGlobal("window", originalWindow);
  }
  await assertNoActions();
});

test("invalid section edits and duplicate item IDs leave the saved minutes unchanged", async () => {
  const turn = await inputTurn();
  const result = resultFor((await commitMinutes(turn, fixture())).turn);
  for (const minutes of [
    { ...result.minutes, summary: "" },
    { ...result.minutes, decisions: ["invalid\nline"] },
    {
      ...result.minutes,
      action_items: [{ ...result.minutes.action_items[0], owner: " " }],
    },
    {
      ...result.minutes,
      open_questions: Array.from({ length: 21 }, () => "Why?"),
    },
    {
      ...result.minutes,
      action_items: result.minutes.action_items.map((item) => ({
        ...item,
        id: "item:0",
      })),
    },
  ]) {
    await assert.rejects(updateMinutes({ ...result, minutes }, turn.sessionId));
    assert.deepEqual(resultFor(await reopenedTurn(turn.id)), result);
  }
});

test("missing, ambiguous, past or normalized dates require an explicit valid future datetime-local", (t) => {
  const fixedNow = new Date(2030, 0, 15, 9, 0).getTime();
  t.mock.method(Date, "now", () => fixedNow);
  for (const input of [
    "",
    "Friday",
    "tomorrow",
    "next week",
    "2099-06-15",
    "06/15/2099 09:30",
    "2030-01-15T08:59",
    "2030-01-15T09:00",
    "2000-01-01T09:30",
    "2099-02-29T09:30",
    "2099-02-30T09:30",
    "2099-13-01T09:30",
    "2099-06-15T24:00",
    "2099-06-15T09:60",
    "2099-06-15T09:30:00",
    "2099-06-15T09:30Z",
    "2099-06-15T09:30+05:30",
    " 2099-06-15T09:30",
  ])
    assert.throws(
      () => confirmedReminderInstant(input),
      /No deadline was guessed/,
      input,
    );
  const expected = new Date(2099, 5, 15, 9, 30)
    .toISOString()
    .replace(/Z$/, "+00:00");
  assert.equal(confirmedReminderInstant("2099-06-15T09:30"), expected);
});

test("storage rejects invalid reminder titles and instants through the normal reminder validator without linking an item", async () => {
  const turn = await inputTurn();
  const result = resultFor((await commitMinutes(turn, fixture())).turn);
  const invalid: [string, string][] = [
    ["", futureInstant],
    [" ", futureInstant],
    ["😀".repeat(201), futureInstant],
    ["Send\nslides", futureInstant],
    ["Send\tslides", futureInstant],
    ["Send\u2028slides", futureInstant],
    ["Send slides", ""],
    ["Send slides", "Friday"],
    ["Send slides", "2099-06-15"],
    ["Send slides", "2099-06-15T09:30"],
    ["Send slides", "not-a-date"],
    ["Send slides", "2000-01-01T09:30:00+00:00"],
    ["Send slides", "2099-06-15T09:30:00+25:00"],
  ];
  for (const [title, dueAt] of invalid) {
    await assert.rejects(addManualReminder(title, dueAt, turn.sessionId));
    await assert.rejects(
      createMinutesReminder(result.id, "item:0", title, dueAt, turn.sessionId),
    );
    assert.deepEqual(resultFor(await reopenedTurn(turn.id)), result);
    await assertNoActions();
  }
  const dueAt = confirmedReminderInstant("2099-06-15T09:30");
  const saved = await createMinutesReminder(
    result.id,
    "item:0",
    "😀".repeat(200),
    dueAt,
    turn.sessionId,
  );
  assert.equal(saved.created, true);
  assert.equal(saved.reminder.title, "😀".repeat(200));
  assert.equal(saved.reminder.dueAt, dueAt);
});

test("concurrent reminder confirmation, reload and reopening create one reminder and stable link", async () => {
  const turn = await inputTurn();
  const result = resultFor((await commitMinutes(turn, fixture())).turn);
  const attempts = await Promise.all([
    createMinutesReminder(
      result.id,
      "item:0",
      "Review the timeline",
      futureInstant,
      turn.sessionId,
    ),
    createMinutesReminder(
      result.id,
      "item:0",
      "Review the timeline",
      futureInstant,
      turn.sessionId,
    ),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.created).length, 1);
  assert.deepEqual(attempts[0].reminder, attempts[1].reminder);
  const reminder = attempts[0].reminder;
  assert.match(reminder.id, /^[a-zA-Z0-9_-]{1,100}$/);
  const reopened = resultFor(await reopenedTurn(turn.id));
  assert.equal(reopened.minutes.action_items[0].reminderId, reminder.id);
  const replay = await createMinutesReminder(
    reopened.id,
    "item:0",
    "Do not replace the saved title",
    "2099-07-01T11:00:00+00:00",
    turn.sessionId,
  );
  assert.equal(replay.created, false);
  assert.deepEqual(replay.reminder, reminder);
  assert.deepEqual((await loadWorkspace()).records, [reminder]);
  assert.deepEqual(await storedRows("commands"), []);
});

test("editing, reordering and removing action items preserve IDs and do not mutate or retarget an existing reminder", async () => {
  const turn = await inputTurn();
  const result = resultFor((await commitMinutes(turn, fixture())).turn);
  const linked = await createMinutesReminder(
    result.id,
    "item:0",
    "Original reminder title",
    futureInstant,
    turn.sessionId,
  );
  const current = resultFor(linked.turn);
  const [first, second] = current.minutes.action_items;
  const reordered = await updateMinutes(
    {
      ...current,
      minutes: {
        ...current.minutes,
        action_items: [
          { ...second, reminderId: "forged-link" },
          {
            ...first,
            task: "Edited task",
            owner: "Meera",
            deadline: "Next month",
            reminderId: "forged-replacement",
          },
        ],
      },
    },
    turn.sessionId,
  );
  const reorderedItems = resultFor(reordered).minutes.action_items;
  assert.deepEqual(
    reorderedItems.map((item) => item.id),
    ["item:1", "item:0"],
  );
  assert.equal(reorderedItems[0].reminderId, undefined);
  assert.equal(reorderedItems[1].reminderId, linked.reminder.id);
  assert.equal(reorderedItems[1].task, "Edited task");
  assert.deepEqual((await loadWorkspace()).records, [linked.reminder]);
  const retained = await updateMinutes(
    {
      ...resultFor(reordered),
      minutes: { ...reordered.minutes!, action_items: [reorderedItems[1]] },
    },
    turn.sessionId,
  );
  assert.equal(retained.minutes!.action_items[0].id, "item:0");
  assert.equal(
    retained.minutes!.action_items[0].reminderId,
    linked.reminder.id,
  );
  await assert.rejects(
    createMinutesReminder(
      result.id,
      "item:1",
      "Removed item",
      futureInstant,
      turn.sessionId,
    ),
  );
  const replay = await createMinutesReminder(
    result.id,
    "item:0",
    "Edited task",
    "2099-07-01T11:00:00+00:00",
    turn.sessionId,
  );
  assert.equal(replay.created, false);
  assert.deepEqual(replay.reminder, linked.reminder);
  await updateMinutes(
    {
      ...resultFor(retained),
      minutes: { ...retained.minutes!, action_items: [] },
    },
    turn.sessionId,
  );
  await assert.rejects(
    createMinutesReminder(
      result.id,
      "item:0",
      "Removed linked item",
      futureInstant,
      turn.sessionId,
    ),
  );
  assert.deepEqual(
    (await loadWorkspace()).records,
    [linked.reminder],
    "Removing minutes text does not delete an independently saved reminder",
  );
});

for (const failure of ["turns", "reminders"] as const) {
  test(`a failed ${failure} request rolls back both the reminder and item link; retry succeeds once`, async (t) => {
    const turn = await inputTurn();
    const result = resultFor((await commitMinutes(turn, fixture())).turn);
    const originalPut = FakeObjectStore.prototype.put;
    const originalAdd = FakeObjectStore.prototype.add;
    const write =
      failure === "turns"
        ? t.mock.method(
            FakeObjectStore.prototype,
            "put",
            function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
              if (this.name === "turns")
                return originalAdd.call(this, value, key);
              return originalPut.call(this, value, key);
            },
          )
        : t.mock.method(
            FakeObjectStore.prototype,
            "add",
            function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
              // The first add and the link write are queued before the duplicate fails.
              if (this.name === "reminders") originalAdd.call(this, value, key);
              return originalAdd.call(this, value, key);
            },
          );
    await assert.rejects(
      createMinutesReminder(
        result.id,
        "item:0",
        "Review",
        futureInstant,
        turn.sessionId,
      ),
    );
    assert.ok(write.mock.callCount() > 0);
    write.mock.restore();
    assert.deepEqual(resultFor(await reopenedTurn(turn.id)), result);
    await assertNoActions();
    const retry = await createMinutesReminder(
      result.id,
      "item:0",
      "Review",
      futureInstant,
      turn.sessionId,
    );
    assert.equal(retry.created, true);
    assert.match(retry.reminder.id, /^[a-zA-Z0-9_-]{1,100}$/);
    assert.equal(
      resultFor(retry.turn).minutes.action_items[0].reminderId,
      retry.reminder.id,
    );
    assert.deepEqual((await loadWorkspace()).records, [retry.reminder]);
    assert.equal(
      (
        await createMinutesReminder(
          result.id,
          "item:0",
          "Review",
          futureInstant,
          turn.sessionId,
        )
      ).created,
      false,
    );
  });
}

test("a failed edit preserves stable IDs and a linked reminder through an explicit save retry", async (t) => {
  const turn = await inputTurn();
  const result = resultFor((await commitMinutes(turn, fixture())).turn);
  const linked = await createMinutesReminder(
    result.id,
    "item:0",
    "Review",
    futureInstant,
    turn.sessionId,
  );
  const before = resultFor(linked.turn);
  const edited: MinutesResult = {
    ...before,
    minutes: {
      ...before.minutes,
      summary: "Edited summary after a failed save.",
    },
  };
  const originalPut = FakeObjectStore.prototype.put;
  const originalAdd = FakeObjectStore.prototype.add;
  const write = t.mock.method(
    FakeObjectStore.prototype,
    "put",
    function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "turns") return originalAdd.call(this, value, key);
      return originalPut.call(this, value, key);
    },
  );
  await assert.rejects(updateMinutes(edited, turn.sessionId));
  write.mock.restore();
  assert.deepEqual(resultFor(await reopenedTurn(turn.id)), before);
  const retry = await updateMinutes(edited, turn.sessionId);
  assert.equal(retry.minutes!.summary, edited.minutes.summary);
  assert.deepEqual(retry.minutes!.action_items, before.minutes.action_items);
  assert.deepEqual((await loadWorkspace()).records, [linked.reminder]);
});

for (const change of ["switch", "delete"] as const) {
  test(`a session ${change} during a delayed fake response prevents commit and leaves no action orphans`, async (t) => {
    const turn = await inputTurn();
    const started = deferred<void>();
    const response = deferred<Response>();
    t.mock.method(globalThis, "fetch", async (path: unknown) => {
      assert.equal(path, "/api/minutes");
      started.resolve(undefined);
      return response.promise;
    });
    // Exercise the real API and storage guard, not an imitation of hook ownership.
    const pending = requestMeetingMinutes(
      turn.transcript,
      "en",
      new AbortController().signal,
    ).then((parsed) => commitMinutes(turn, parsed));
    const rejected = assert.rejects(pending);
    await started.promise;
    if (change === "switch") await selectWorkspaceSession();
    else await deleteWorkspaceSession(turn.sessionId);
    response.resolve(jsonResponse(fixture()));
    await rejected;
    const workspace = await loadWorkspace();
    assert.notEqual(workspace.selectedSession, turn.sessionId);
    assert.equal(
      workspace.turns.some((entry) => entry.minutes),
      false,
    );
    assert.equal(
      workspace.turns.some(
        (entry) => entry.sessionId === workspace.selectedSession,
      ),
      false,
    );
    await assertNoActions();
    await assert.rejects(storeMinutesInput(turn));
    if (change === "switch") {
      assert.deepEqual(await reopenedTurn(turn.id), turn);
      await selectWorkspaceSession(turn.sessionId);
      assert.equal((await commitMinutes(turn, fixture())).turn.id, turn.id);
    } else {
      assert.equal(
        workspace.sessions.some((session) => session.id === turn.sessionId),
        false,
      );
      assert.equal(
        workspace.turns.some((entry) => entry.id === turn.id),
        false,
      );
    }
  });
}

test("cross-session saves, edits and reminder confirmation are rejected and existing session deletion removes its records", async () => {
  const turn = await inputTurn();
  const saved = await commitMinutes(turn, fixture());
  const result = resultFor(saved.turn);
  const linked = await createMinutesReminder(
    result.id,
    "item:0",
    "Review",
    futureInstant,
    turn.sessionId,
  );
  const other = await selectWorkspaceSession();
  await assert.rejects(
    storeMinutesInput({ ...turn, id: "stale-session-input" }),
  );
  await assert.rejects(
    storeMinutesInput({ ...turn, sessionId: other.selected }),
  );
  await assert.rejects(commitMinutes(turn, fixture()));
  await assert.rejects(updateMinutes(result, turn.sessionId));
  await assert.rejects(updateMinutes(result, other.selected));
  await assert.rejects(
    createMinutesReminder(
      result.id,
      "item:1",
      "Review",
      futureInstant,
      turn.sessionId,
    ),
  );
  await assert.rejects(
    createMinutesReminder(
      result.id,
      "item:1",
      "Review",
      futureInstant,
      other.selected,
    ),
  );
  assert.deepEqual((await loadWorkspace()).records, [linked.reminder]);
  const deletion = await deleteWorkspaceSession(turn.sessionId);
  assert.equal(deletion.selected, other.selected);
  assert.deepEqual((await loadWorkspace()).turns, []);
  await assertNoActions();
  await assert.rejects(commitMinutes(turn, fixture()));
  await assert.rejects(
    createMinutesReminder(
      result.id,
      "item:0",
      "Review",
      futureInstant,
      turn.sessionId,
    ),
  );
});

test("unfinished input keeps its language and identity through refresh without a result", async () => {
  const workspace = await loadWorkspace();
  const turn: Turn = {
    id: "unfinished-hindi-minutes",
    sessionId: workspace.selectedSession,
    createdAt: "2030-01-15T09:00:00.000Z",
    transcript: "समीक्षा कल होगी।",
    minutesInputLanguage: "hi",
  };
  await storeMinutesInput(turn);
  const restored = await reopenedTurn(turn.id);
  assert.deepEqual(restored, turn);
  assert.equal(restored.minutes, undefined);
  const saved = await commitMinutes(
    restored,
    fixture(),
    restored.minutesInputLanguage,
  );
  assert.equal(saved.turn.id, turn.id);
  assert.equal(saved.turn.replyLanguage, "hi");
  assert.equal((await loadWorkspace()).turns.length, 1);
  await assertNoActions();
});

test("restoring a removed action identity preserves its original reminder relationship", async () => {
  const turn = await inputTurn();
  const result = resultFor((await commitMinutes(turn, fixture())).turn);
  const linked = await createMinutesReminder(
    result.id,
    "item:0",
    "Review",
    futureInstant,
    turn.sessionId,
  );
  const originalItem = resultFor(linked.turn).minutes.action_items[0];
  const removed = await updateMinutes(
    {
      ...resultFor(linked.turn),
      minutes: { ...linked.turn.minutes!, action_items: [] },
    },
    turn.sessionId,
  );
  const restored = await updateMinutes(
    {
      ...resultFor(removed),
      minutes: {
        ...removed.minutes!,
        action_items: [{ ...originalItem, reminderId: undefined }],
      },
    },
    turn.sessionId,
  );
  assert.equal(
    restored.minutes!.action_items[0].reminderId,
    linked.reminder.id,
  );
  const retried = await createMinutesReminder(
    result.id,
    "item:0",
    "Not another reminder",
    futureInstant,
    turn.sessionId,
  );
  assert.equal(retried.created, false);
  assert.equal(retried.reminder.id, linked.reminder.id);
  assert.deepEqual((await loadWorkspace()).records, [linked.reminder]);
});

test("bounded speech does not start inside a decimal in an overlong first sentence", () => {
  const summary = `Revenue was 2.5 million ${"words ".repeat(45)}approved. A later sentence.`;
  assert.equal(
    minutesSpeech(summary, "en"),
    "Your meeting minutes are saved. Read the full summary and edit it if needed.",
  );
});

// Declarative browser fixtures only. These are NOT node:test coverage or executed QA.
// They need a separately approved browser suite; no React test framework is added here.
export const minutesBrowserScenarios = [
  {
    name: "Reopen and retry a failed minutes save",
    execution: "not executed",
    steps: [
      "Generate minutes, retain a valid response and fail the IndexedDB save.",
      "Close and reopen the minutes dialog with the same session, transcript and language, then retry.",
    ],
    expected: [
      "The notes and error remain available; the retry uses the same turn and cached response.",
      "One minutes result is saved, with no command interpretation, automatic download or premature saved confirmation.",
    ],
  },
  {
    name: "Rapid controls and an edited reminder confirmation",
    execution: "not executed",
    steps: [
      "Rapidly activate Generate, then reopen the saved minutes and edit every section.",
      "Open Create reminder for an action with an unstated or ambiguous deadline, choose a future local time, then confirm twice.",
      "Reload, reopen the result, remove a different unlinked item, and download the edited minutes.",
    ],
    expected: [
      "Busy controls prevent duplicate UI work and recording remains unavailable while minutes work is active.",
      "No reminder is created before explicit time confirmation; one linked reminder survives reopening and edits to the item list.",
      "The downloaded text contains the persisted edits and no real email is sent.",
    ],
  },
  {
    name: "Cancel, switch or delete while a request is pending",
    execution: "not executed",
    steps: [
      "Delay the fake minutes response. Check that the modal cannot close and same-tab switch/delete controls cannot start conflicting work. Cancel through the request lifecycle, or switch/delete in another fixture tab before resolving it.",
      "Return to a surviving original conversation and explicitly retry, then change transcript or reply language and generate again.",
    ],
    expected: [
      "Stale responses do not update another conversation, announce success, download files or create actions.",
      "A surviving input remains retryable; deleting the conversation removes its input and prevents resurrection.",
      "An unchanged retry keeps its turn ID; changing transcript or language starts a separate request rather than reusing stale minutes.",
    ],
  },
] as const;
