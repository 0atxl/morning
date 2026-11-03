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
  parseLookupContext,
  lookupProgress,
  type LookupResult,
} from "../src/lib/lookup-result.ts";
import {
  commitLookup,
  loadWorkspace,
  lookupRecord,
  selectWorkspaceSession,
  storeTurn,
  type Turn,
} from "../src/lib/reminder-store.ts";
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
