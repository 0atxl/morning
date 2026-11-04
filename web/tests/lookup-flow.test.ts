import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import {
  parseCommandResponse,
  postJSON,
  RequestError,
  type CommandRequest,
} from "../src/lib/command-api.ts";
import {
  continuesLookupContext,
  parseLookupContext,
  lookupProgress,
  type LookupResult,
} from "../src/lib/lookup-result.ts";
import {
  commitLookup,
  deleteWorkspaceSession,
  loadWorkspace,
  lookupRecord,
  previousTurnContext,
  earlierActivity,
  selectWorkspaceSession,
  storeTurn,
  type Turn,
} from "../src/lib/reminder-store.ts";
import {
  deadlineInstant,
  minutesComposeUrl,
  nextRecurringDue,
  resultText,
  type WorkspaceResult,
} from "../src/lib/results.ts";
import { SpokenReply } from "../src/lib/spoken-reply.ts";

// Offline definitions only. Each case uses a fresh, in-memory guest workspace.
const originalFactory = Object.getOwnPropertyDescriptor(
  globalThis,
  "indexedDB",
);
beforeEach(() =>
  Object.defineProperty(globalThis, "indexedDB", {
    value: new IDBFactory(),
    configurable: true,
    writable: true,
  }),
);
afterEach(() => {
  if (originalFactory)
    Object.defineProperty(globalThis, "indexedDB", originalFactory);
  else Reflect.deleteProperty(globalThis, "indexedDB");
});

const snapshot: LookupResult = {
  kind: "hotels",
  query: "Hotels near Jaipur railway station",
  status: "answered",
  answer: "I found Hotel Station Garden near Jaipur railway station.",
  speech: "I found Hotel Station Garden near Jaipur railway station.",
  sources: [
    {
      title: "Hotel Station Garden",
      url: "https://station-garden.example/jaipur",
      publisher: "station-garden.example",
    },
  ],
  looked_up_at: "2026-11-03T03:30:00Z",
};
const request: CommandRequest = {
  command_id: "lookup-turn",
  transcript: "Find three hotels near Jaipur railway station",
  now: "2026-11-03T09:00:00+05:30",
  timezone: "Asia/Kolkata",
};
const envelope = {
  command_id: request.command_id,
  actions: [],
  clarification: null,
  lookup: snapshot,
};

async function savedTurn(): Promise<Turn> {
  const workspace = await loadWorkspace();
  const turn = {
    id: request.command_id,
    sessionId: workspace.selectedSession,
    transcript: request.transcript,
    createdAt: request.now,
  };
  await storeTurn(turn);
  return turn;
}

test("lookup replies are read-only and cannot accompany action or reply envelopes", () => {
  const result = parseCommandResponse(envelope, request);
  assert.equal(result.kind, "lookup");
  for (const change of [
    {
      actions: [
        {
          type: "create_reminder",
          title: "Injected reminder",
          due_at: "2026-11-03T09:10:00+05:30",
        },
      ],
    },
    { reply: "Unverified answer" },
    { clarification: "Which city?" },
    { clarification_options: [] },
    {
      lookup_context: {
        query: { kind: "hotels", terms: "", place: "", today: false },
      },
    },
  ])
    assert.throws(() =>
      parseCommandResponse({ ...envelope, ...change }, request),
    );
});

test("a Hindi lookup keeps its language and sources through History storage", async () => {
  const parsed = parseCommandResponse(
    {
      ...envelope,
      reply_language: "hi",
      lookup: {
        ...snapshot,
        answer: "जयपुर रेलवे स्टेशन के पास Hotel Station Garden मिला।",
        speech: "जयपुर रेलवे स्टेशन के पास Hotel Station Garden मिला।",
      },
    },
    request,
  );
  assert.equal(parsed.kind, "lookup");
  if (parsed.kind !== "lookup") return;
  await commitLookup(await savedTurn(), parsed.result);
  const reopened = await loadWorkspace();
  const saved = reopened.turns.find(
    (turn) => turn.id === request.command_id,
  )?.lookup;
  assert.equal(saved?.reply_language, "hi");
  assert.deepEqual(saved?.sources, snapshot.sources);
  assert.equal(saved?.looked_up_at, snapshot.looked_up_at);
});

test("a spoken place keeps the pending lookup and cannot turn into a reminder", () => {
  const context = parseLookupContext({
    query: { kind: "hotels", terms: "", place: "", today: false },
  });
  const clarification = parseCommandResponse(
    {
      command_id: request.command_id,
      actions: [],
      clarification: "Which city or landmark?",
      lookup_context: context,
    },
    request,
  );
  assert.equal(clarification.kind, "clarification");
  if (clarification.kind !== "clarification") return;
  assert.deepEqual(clarification.lookupContext, context);
  const reply: CommandRequest = {
    ...request,
    command_id: "place-reply",
    transcript: "Jaipur railway station",
    lookup_context: context,
  };
  assert.equal(
    parseCommandResponse({ ...envelope, command_id: reply.command_id }, reply)
      .kind,
    "lookup",
  );
  assert.throws(() =>
    parseCommandResponse(
      {
        command_id: reply.command_id,
        actions: [
          {
            type: "create_reminder",
            title: "Injected",
            due_at: "2026-11-03T09:10:00+05:30",
          },
        ],
        clarification: null,
      },
      reply,
    ),
  );
  assert.throws(() => parseLookupContext({ ...context, tool: "send_email" }));
  assert.throws(() =>
    parseLookupContext({ query: { ...context.query, kind: "draft_email" } }),
  );
});

test("all requested demo lookups show Searching, including a spoken place reply", () => {
  for (const transcript of [
    "Find three hotels near Jaipur railway station",
    "What's the weather in Pune right now?",
    "What's the latest technology news in India today?",
    "What's the latest stable Go release?",
    "What time is it in Tokyo?",
  ])
    assert.equal(lookupProgress(transcript), true, transcript);
  assert.equal(
    lookupProgress("Jaipur railway station", {
      query: { kind: "hotels", terms: "", place: "", today: false },
    }),
    true,
  );
  assert.equal(
    lookupProgress("Remind me in ten minutes to check the oven"),
    false,
  );
  const weatherPending = {
    query: { kind: "weather" as const, terms: "", place: "", today: false },
  };
  assert.equal(continuesLookupContext("Pune, India", weatherPending), true);
  assert.equal(
    continuesLookupContext("What's the weather in Pune?", weatherPending),
    true,
  );
  assert.equal(
    continuesLookupContext(
      "Remind me to drink water in ten minutes",
      weatherPending,
    ),
    false,
  );
  assert.equal(
    continuesLookupContext(
      "Draft Priya an email asking for the slides",
      weatherPending,
    ),
    false,
  );
  assert.equal(
    continuesLookupContext("What time is it in Tokyo?", weatherPending),
    false,
  );
});

test("a lookup quota error scopes its cooldown to lookup retry", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "lookup_quota_limited",
            message: "The lookup provider's quota was reached.",
            retryable: true,
          },
        }),
        {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "60" },
        },
      ),
  );
  await assert.rejects(
    postJSON("/api/commands", request, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.lookupOnly, true);
      assert.ok(error.retryAt > Date.now());
      return true;
    },
  );
});

test("a lookup completes in its original conversation after switching History and replays its first snapshot", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("History and persistence must not call providers");
  });
  const turn = await savedTurn();
  const other = await selectWorkspaceSession();
  const saved = await commitLookup(turn, snapshot);
  assert.equal(saved.created, true);
  assert.equal(saved.turn.sessionId, turn.sessionId);
  assert.deepEqual(saved.turn.lookup, snapshot);
  assert.equal(saved.turn.reply, snapshot.answer);
  assert.equal((await loadWorkspace()).selectedSession, other.selected);
  const replay = await commitLookup(turn, {
    ...snapshot,
    answer: "A later answer",
    looked_up_at: "2026-11-03T04:00:00Z",
  });
  assert.equal(replay.created, false);
  assert.deepEqual(replay.turn.lookup, snapshot);
  await selectWorkspaceSession(turn.sessionId);
  const history = await loadWorkspace();
  const stored = history.turns.find((item) => item.id === turn.id)!;
  assert.deepEqual(stored.lookup, snapshot);
  assert.equal(lookupRecord(stored)?.commandId, turn.id);
  assert.equal(lookupRecord(stored)?.sessionId, turn.sessionId);
  assert.deepEqual(history.records, []);
  await assert.rejects(
    commitLookup({ ...turn, sessionId: other.selected }, snapshot),
  );
});

test("a failed lookup save retains the transcript and retry saves the same snapshot", async (t) => {
  const turn = await savedTurn();
  const originalPut = IDBObjectStore.prototype.put;
  const write = t.mock.method(
    IDBObjectStore.prototype,
    "put",
    function (this: IDBObjectStore, ...args: Parameters<typeof originalPut>) {
      if (this.name === "turns" && (args[0] as Turn).lookup)
        throw new DOMException("Fixture quota", "QuotaExceededError");
      return originalPut.apply(this, args);
    },
  );
  await assert.rejects(commitLookup(turn, snapshot));
  write.mock.restore();
  const retained = (await loadWorkspace()).turns.find(
    (item) => item.id === turn.id,
  )!;
  assert.equal(retained.transcript, turn.transcript);
  assert.equal(retained.lookup, undefined);
  assert.equal(retained.reply, undefined);
  const retry = await commitLookup(turn, snapshot);
  assert.equal(retry.created, true);
  assert.deepEqual(retry.turn.lookup, snapshot);
});

test("a saved lookup Play reply uses speech only and reuses its clip", async (t) => {
  const requests: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (path: string, init: RequestInit) => {
      requests.push(path);
      assert.equal(path, "/api/speech");
      assert.deepEqual(JSON.parse(String(init.body)), {
        text: snapshot.speech,
      });
      return new Response(new Blob(["fixture"]), {
        headers: { "Content-Type": "audio/mpeg" },
      });
    },
  );
  class AudioStub {
    play() {
      return Promise.resolve();
    }
    pause() {}
    load() {}
    removeAttribute() {}
  }
  const originals = ["window", "Audio"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, "window", {
    value: { setTimeout, clearTimeout },
    configurable: true,
  });
  Object.defineProperty(globalThis, "Audio", {
    value: AudioStub,
    configurable: true,
  });
  const reply = new SpokenReply(snapshot.speech, () => {});
  t.after(() => {
    reply.stop();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await reply.start();
  reply.play();
  assert.deepEqual(requests, ["/api/speech"]);
});

test("wiki lookups parse correctly and format a clean downloadable text summary", () => {
  const wikiSnapshot: LookupResult = {
    kind: "wiki",
    query: "Adolf Hitler",
    status: "answered",
    answer:
      "Adolf Hitler (Dictator of Germany from 1933 to 1945)\n\nAdolf Hitler was an Austrian-born German politician who was dictator of Germany in the Nazi era from 1933 until his suicide in 1945.",
    speech:
      "Adolf Hitler was an Austrian-born German politician who was dictator of Germany from 1933 until his suicide in 1945.",
    sources: [
      {
        title: "Adolf Hitler - Wikipedia",
        url: "https://en.wikipedia.org/wiki/Adolf_Hitler",
        publisher: "Wikipedia",
        excerpt: "Adolf Hitler was an Austrian-born German politician...",
      },
    ],
    looked_up_at: "2026-11-04T12:00:00Z",
  };
  const response = parseCommandResponse(
    {
      command_id: "wiki-turn",
      actions: [],
      clarification: null,
      lookup: wikiSnapshot,
    },
    {
      command_id: "wiki-turn",
      transcript: "Tell me about Adolf Hitler and give me a text file",
      now: "2026-11-04T12:00:00Z",
      timezone: "Asia/Kolkata",
    },
  );
  assert.equal(response.kind, "lookup");
  if (response.kind !== "lookup") return;
  assert.equal(response.result.kind, "wiki");
  assert.equal(response.result.query, "Adolf Hitler");

  const formatted = resultText({
    id: "wiki-result",
    title: "Adolf Hitler",
    transcript: "Tell me about Adolf Hitler",
    kind: "lookup",
    lookup: wikiSnapshot,
  });
  assert.ok(formatted.includes("ADOLF HITLER"));
  assert.ok(formatted.includes("Summary from Wikipedia"));
  assert.ok(formatted.includes("https://en.wikipedia.org/wiki/Adolf_Hitler"));
});

test("meeting minutes result formats clean structured minutes with decisions and action items", () => {
  const minutesResult: WorkspaceResult = {
    id: "minutes-1",
    title: "Meeting Minutes",
    transcript: "We will ship on Friday. Priya will send slides. Atul will test.",
    kind: "minutes",
    minutes: {
      summary: "The team agreed on Friday launch and assigned preparation tasks.",
      decisions: ["Launch on Friday"],
      action_items: [
        { task: "Send slides", owner: "Priya", deadline: "Thursday" },
        { task: "Test build", owner: "Atul", deadline: null },
      ],
      open_questions: ["Who coordinates user support?"],
    },
  };
  const text = resultText(minutesResult);
  assert.ok(text.includes("SUMMARY"));
  assert.ok(text.includes("DECISIONS"));
  assert.ok(text.includes("• Launch on Friday"));
  assert.ok(text.includes("ACTION ITEMS"));
  assert.ok(text.includes("• Send slides (Owner: Priya) [Deadline: Thursday]"));
  assert.ok(text.includes("• Test build (Owner: Atul)"));
  assert.ok(text.includes("OPEN QUESTIONS"));
  assert.ok(text.includes("• Who coordinates user support?"));
});

test("command request accepts and preserves previous turn context", () => {
  const followUpRequest: CommandRequest = {
    command_id: "followup-1",
    transcript: "When did he die?",
    now: "2026-11-04T12:05:00Z",
    timezone: "Asia/Kolkata",
    previous_turn: {
      transcript: "Tell me about Adolf Hitler",
      topic: "Adolf Hitler",
      answer: "Adolf Hitler was an Austrian-born German politician.",
      reply: "Adolf Hitler was an Austrian-born German politician.",
    },
  };
  assert.equal(followUpRequest.previous_turn?.topic, "Adolf Hitler");
  assert.equal(followUpRequest.previous_turn?.transcript, "Tell me about Adolf Hitler");
});

test("deadlineInstant computes future ISO timestamp for relative and named days", () => {
  const tomorrow = deadlineInstant("tomorrow");
  assert.ok(tomorrow.includes("T09:00:00.000Z"));
  assert.ok(Date.parse(tomorrow) > Date.now());

  const thursday = deadlineInstant("Thursday");
  assert.ok(thursday.includes("T09:00:00.000Z"));
  assert.ok(Date.parse(thursday) > Date.now());

  const fallback = deadlineInstant(null);
  assert.ok(fallback.includes("T09:00:00.000Z"));
});

test("minutesComposeUrl generates valid Gmail compose URL with prefilled minutes text", () => {
  const url = minutesComposeUrl({
    summary: "Product sync discussion",
    decisions: ["Ship on Friday"],
    action_items: [{ task: "Deploy build", owner: "Atul", deadline: "Thursday" }],
    open_questions: [],
  });
  assert.ok(url.startsWith("https://mail.google.com/mail/?"));
  assert.ok(url.includes("view=cm"));
  assert.ok(url.includes("Meeting+Minutes"));
  assert.ok(url.includes("Deploy+build"));
});

test("parseCommandResponse parses briefing lookup correctly", () => {
  const briefingSnapshot: LookupResult = {
    kind: "briefing",
    query: "Pune",
    status: "answered",
    answer: "Good morning! In Pune it's 24.5 °C and clear. Top headlines: ...",
    speech: "Good morning! In Pune it's 24.5 degrees Celsius and clear.",
    sources: [
      {
        title: "Weather by Open-Meteo",
        url: "https://api.open-meteo.com/v1/forecast",
        publisher: "Open-Meteo",
      },
    ],
    looked_up_at: "2026-11-04T07:00:00Z",
    timezone: "Asia/Kolkata",
    data_time: "2026-11-04T06:45:00Z",
  };
  const response = parseCommandResponse(
    {
      command_id: "briefing-1",
      actions: [],
      clarification: null,
      lookup: briefingSnapshot,
    },
    {
      command_id: "briefing-1",
      transcript: "Give me my morning briefing",
      now: "2026-11-04T07:00:00Z",
      timezone: "Asia/Kolkata",
    },
  );
  assert.equal(response.kind, "lookup");
  if (response.kind !== "lookup") return;
  assert.equal(response.result.kind, "briefing");
  assert.ok(response.result.answer.includes("Good morning!"));
});

test("nextRecurringDue correctly rolls forward for daily, weekly, and weekdays", () => {
  const baseTime = "2026-11-04T09:00:00.000Z";

  const daily = nextRecurringDue(baseTime, "daily");
  assert.ok(Date.parse(daily) > Date.now());

  const weekly = nextRecurringDue(baseTime, "weekly");
  assert.ok(Date.parse(weekly) > Date.now());

  const weekdays = nextRecurringDue(baseTime, "weekdays");
  const nextDate = new Date(weekdays);
  assert.ok(nextDate.getDay() >= 1 && nextDate.getDay() <= 5);
});

test("parseCommandResponse preserves repeat recurrence on create_reminder", () => {
  const response = parseCommandResponse(
    {
      command_id: "rec-rem-1",
      actions: [
        {
          type: "create_reminder",
          title: "Take vitamins",
          due_at: "2026-11-05T09:00:00+05:30",
          repeat: "daily",
        },
      ],
      clarification: null,
      lookup: null,
    },
    {
      command_id: "rec-rem-1",
      transcript: "Remind me every day at 9 AM to take vitamins",
      now: "2026-11-04T08:00:00Z",
      timezone: "Asia/Kolkata",
    },
  );
  assert.equal(response.kind, "actions");
  if (response.kind !== "actions") return;
  assert.equal(response.actions[0].type, "create_reminder");
  if (response.actions[0].type === "create_reminder") {
    assert.equal(response.actions[0].repeat, "daily");
  }
});

test("deleteWorkspaceSession removes session, associated turns, and switches selection", async () => {
  const initial = await loadWorkspace();
  const session1 = initial.selectedSession;

  const { selected: session2 } = await selectWorkspaceSession();
  assert.notEqual(session1, session2);

  const turn: Turn = {
    id: "turn-to-delete",
    sessionId: session2,
    transcript: "Test turn",
    createdAt: new Date().toISOString(),
  };
  await storeTurn(turn);

  const before = await loadWorkspace();
  assert.equal(before.sessions.length, 2);
  assert.ok(before.turns.some((t) => t.id === "turn-to-delete"));

  const result = await deleteWorkspaceSession(session2);
  assert.equal(result.selected, session1);

  const after = await loadWorkspace();
  assert.equal(after.sessions.length, 1);
  assert.equal(after.selectedSession, session1);
  assert.ok(!after.turns.some((t) => t.id === "turn-to-delete"));
});

test("previous-turn memory selects the latest completed answer in the active session", () => {
  const answered: Turn = {
    id: "answer",
    sessionId: "active",
    createdAt: "2026-11-04T10:00:00Z",
    transcript: "Find hotels near Jaipur railway station",
    lookup: snapshot,
  };
  const turns: Turn[] = [
    {
      ...answered,
      id: "other",
      sessionId: "other",
      createdAt: "2026-11-04T12:00:00Z",
    },
    { ...answered, id: "older", createdAt: "2026-11-04T09:00:00Z" },
    answered,
    {
      id: "write",
      sessionId: "active",
      createdAt: "2026-11-04T11:00:00Z",
      transcript: "Remind me to call Priya",
    },
    {
      id: "pending",
      sessionId: "active",
      createdAt: "2026-11-04T11:30:00Z",
      transcript: "Weather near me",
      reply: "Which city?",
      lookupContext: {
        query: { kind: "weather", terms: "", place: "", today: false },
      },
    },
  ];
  assert.deepEqual(previousTurnContext(turns, "active"), {
    transcript: answered.transcript,
    topic: snapshot.query,
    answer: snapshot.answer,
  });
  assert.equal(previousTurnContext(turns, "new-session"), undefined);
  assert.equal(previousTurnContext(turns, earlierActivity), undefined);
  assert.equal(previousTurnContext([turns[3]], "active"), undefined);
  assert.equal(turns[0].id, "other");
});

test("previous-turn fields obey Go's UTF-8 byte limits without splitting Hindi or emoji", () => {
  const context = previousTurnContext(
    [
      {
        id: "unicode",
        sessionId: "active",
        createdAt: "2026-11-04T10:00:00Z",
        transcript: "अ".repeat(3000),
        lookup: {
          ...snapshot,
          query: "😀".repeat(100),
          answer: "अ".repeat(2000),
        },
        reply: "😀".repeat(300),
      },
    ],
    "active",
  )!;
  for (const [key, max] of Object.entries({
    transcript: 8192,
    topic: 300,
    answer: 4000,
    reply: 1000,
  })) {
    const value = context[key as keyof typeof context]!;
    assert.ok(new TextEncoder().encode(value).length <= max, key);
    assert.ok(!value.includes("\ufffd"), key);
  }
  assert.deepEqual(
    previousTurnContext(
      [
        {
          id: "minutes",
          sessionId: "active",
          createdAt: "2026-11-04T11:00:00Z",
          transcript: "Meeting discussion",
          minutes: {
            summary: "Launch Friday",
            decisions: [],
            action_items: [],
            open_questions: [],
          },
        },
      ],
      "active",
    ),
    {
      transcript: "Meeting discussion",
      topic: "Meeting notes",
      answer: "Launch Friday",
    },
  );
});

test("briefing place clarification stays read-only and preserves today=true", () => {
  const lookup_context = {
    query: { kind: "briefing", terms: "", place: "", today: true },
  };
  const response = parseCommandResponse(
    {
      command_id: request.command_id,
      actions: [],
      clarification: "Which city?",
      lookup_context,
    },
    request,
  );
  assert.equal(response.kind, "clarification");
  if (response.kind !== "clarification") return;
  assert.equal(response.lookupContext?.query.today, true);
  assert.throws(() =>
    parseLookupContext({ query: { ...lookup_context.query, today: false } }),
  );
  assert.throws(() =>
    parseCommandResponse(
      {
        command_id: request.command_id,
        actions: [
          {
            type: "create_reminder",
            title: "Injected",
            due_at: "2026-11-05T09:00:00+05:30",
          },
        ],
        clarification: "Which city?",
        lookup_context,
      },
      request,
    ),
  );
});
