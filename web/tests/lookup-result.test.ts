import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLookupResult, safeLookupLink } from "../src/lib/lookup-result.ts";

// Synthetic snapshots only. These definitions do not use fetch or providers.
const snapshot = {
  kind: "news",
  query: "technology India",
  status: "answered",
  answer:
    "The latest matching story is India launches a technology research centre.",
  speech:
    "The latest matching story is India launches a technology research centre.",
  sources: [
    {
      title: "India launches a technology research centre",
      url: "https://science-daily.example/india-centre",
      publisher: "science-daily.example",
      published_at: "2026-11-03T02:00:00Z",
    },
  ],
  looked_up_at: "2026-11-03T03:30:00Z",
  timezone: "Asia/Kolkata",
  window_start: "2026-11-02T18:30:00Z",
  window_end: "2026-11-03T03:30:00Z",
};

test("a saved lookup keeps publication and lookup times separate across serialization", () => {
  const result = parseLookupResult(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(result, snapshot);
  assert.notEqual(result.looked_up_at, result.sources[0].published_at);
  assert.notEqual(result.sources, snapshot.sources);
});

test("lookup links accept HTTP(S) public hostnames and reject executable or local URLs", () => {
  assert.equal(
    safeLookupLink("https://example.com/story#details"),
    "https://example.com/story",
  );
  assert.equal(
    safeLookupLink("http://example.com/story"),
    "http://example.com/story",
  );
  for (const link of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "//example.com",
    "https://user:secret@example.com",
    "http://localhost",
    "http://127.0.0.1",
    "http://2130706433",
    "http://[::ffff:127.0.0.1]",
    "https://example.com\\@evil.example",
    "https://example.com\n",
  ]) {
    assert.equal(safeLookupLink(link), null, link);
    assert.throws(() =>
      parseLookupResult({
        ...snapshot,
        sources: [{ ...snapshot.sources[0], url: link }],
      }),
    );
  }
});

test("today's news rejects missing, old or future publication dates", () => {
  for (const published_at of [
    undefined,
    "2026-11-02T12:00:00Z",
    "2026-11-04T02:00:00Z",
    "today",
    "2026-11-03",
  ]) {
    assert.throws(() =>
      parseLookupResult({
        ...snapshot,
        sources: [{ ...snapshot.sources[0], published_at }],
      }),
    );
  }
  assert.throws(() =>
    parseLookupResult({ ...snapshot, window_start: undefined }),
  );
  assert.throws(() =>
    parseLookupResult({
      ...snapshot,
      window_start: snapshot.window_end,
      window_end: snapshot.window_start,
    }),
  );
});

test("an empty news window is an honest persisted answer with no sources", () => {
  const result = parseLookupResult({
    ...snapshot,
    status: "empty",
    sources: [],
    answer: "No stories met the requested window.",
    speech: "No stories met the requested window.",
  });
  assert.equal(result.status, "empty");
  assert.deepEqual(result.sources, []);
});

test("weather and briefing snapshots preserve observation time and require a timezone", () => {
  for (const kind of ["weather", "briefing"]) {
    const weather = {
      kind,
      query: "Pune",
      status: "answered",
      answer: "Pune is partly cloudy, 24.5 °C. Weather by Open-Meteo.",
      speech: "Pune is partly cloudy, 24.5 °C. Weather by Open-Meteo.",
      sources: [
        {
          title: "Current weather",
          url: "https://open-meteo.com/",
          publisher: "Open-Meteo",
        },
      ],
      looked_up_at: snapshot.looked_up_at,
      data_time: "2026-11-03T08:45:00+05:30",
      timezone: "Asia/Kolkata",
    };
    const result = parseLookupResult(weather);
    assert.equal(result.data_time, weather.data_time);
    assert.notEqual(
      Date.parse(result.data_time!),
      Date.parse(result.looked_up_at),
    );
    for (const change of [
      { data_time: undefined },
      { data_time: "today" },
      { timezone: undefined },
      { timezone: "Invented/Zone" },
      { timezone: "Local" },
    ])
      assert.throws(() => parseLookupResult({ ...weather, ...change }), kind);
  }
});

test("empty Wikipedia ambiguity results accept zero to three useful sources without becoming answered", () => {
  const source = {
    title: "Mercury - Wikipedia",
    url: "https://en.wikipedia.org/wiki/Mercury",
    publisher: "Wikipedia",
    excerpt: "Mercury may refer to a planet, an element, or a Roman god.",
  };
  const ambiguity = {
    kind: "wiki",
    query: "Mercury",
    status: "empty",
    answer: "Mercury has several meanings.\n\nPlease specify a topic.",
    speech: "Mercury has several meanings. Please specify a topic.",
    sources: [source],
    looked_up_at: snapshot.looked_up_at,
  };
  for (const count of [0, 1, 2, 3]) {
    const result = parseLookupResult({
      ...ambiguity,
      sources: Array(count).fill(source),
    });
    assert.equal(result.status, "empty");
    assert.equal(result.sources.length, count);
  }
  for (const count of [1, 2, 3])
    assert.equal(
      parseLookupResult({
        ...ambiguity,
        status: "answered",
        sources: Array(count).fill(source),
      }).status,
      "answered",
    );
  for (const change of [
    { status: "answered", sources: [] },
    { sources: Array(4).fill(source) },
    { sources: [{ ...source, url: "javascript:alert(1)" }] },
    { sources: [{ ...source, published_at: "today" }] },
    { sources: [{ ...source, tool_call: "send_email" }] },
  ])
    assert.throws(() => parseLookupResult({ ...ambiguity, ...change }));
  assert.equal(
    parseLookupResult({
      ...ambiguity,
      kind: "web",
      answer: ambiguity.speech,
    }).status,
    "empty",
  );
});

test("briefing headlines require a paired news window and dated rows inside it", () => {
  const briefing = {
    kind: "briefing",
    query: "Pune",
    status: "answered",
    answer:
      "Pune is partly cloudy, 24.5 °C.\n\nTop headline: a research centre opens.",
    speech: "Pune is partly cloudy, 24.5 °C. A research centre opens.",
    sources: [
      {
        title: "Current weather",
        url: "https://open-meteo.com/",
        publisher: "Open-Meteo",
      },
      snapshot.sources[0],
    ],
    looked_up_at: snapshot.looked_up_at,
    data_time: "2026-11-03T08:45:00+05:30",
    timezone: snapshot.timezone,
    window_start: snapshot.window_start,
    window_end: snapshot.window_end,
  };
  assert.deepEqual(parseLookupResult(briefing), briefing);
  for (const published_at of [briefing.window_start, briefing.window_end])
    assert.equal(
      parseLookupResult({
        ...briefing,
        sources: [
          briefing.sources[0],
          { ...snapshot.sources[0], published_at },
        ],
      }).sources[1].published_at,
      published_at,
    );
  for (const change of [
    { window_start: undefined },
    { window_end: undefined },
    { window_start: undefined, window_end: undefined },
    { window_start: "today" },
    { window_end: null },
    { window_start: briefing.window_end, window_end: briefing.window_start },
  ])
    assert.throws(() => parseLookupResult({ ...briefing, ...change }));
  for (const published_at of [
    "2026-11-02T12:00:00Z",
    "2026-11-04T02:00:00Z",
    "today",
  ])
    assert.throws(() =>
      parseLookupResult({
        ...briefing,
        sources: [
          briefing.sources[0],
          { ...snapshot.sources[0], published_at },
        ],
      }),
    );

  const undatedSources = briefing.sources.map((source) => ({
    ...source,
    published_at: undefined,
  }));
  assert.throws(() =>
    parseLookupResult({
      ...briefing,
      sources: undatedSources,
      window_start: undefined,
      window_end: undefined,
    }),
  );
  assert.throws(() =>
    parseLookupResult({ ...briefing, sources: undatedSources }),
  );
  assert.throws(() =>
    parseLookupResult({
      ...briefing,
      sources: [...briefing.sources, undatedSources[1]],
    }),
  );

  for (const source of briefing.sources) Object.freeze(source);
  Object.freeze(briefing.sources);
  Object.freeze(briefing);
  const restored = parseLookupResult(JSON.parse(JSON.stringify(briefing)));
  assert.deepEqual(restored, briefing);
  assert.deepEqual(parseLookupResult(restored), briefing);
  assert.notEqual(restored.sources, briefing.sources);
  assert.notEqual(restored.looked_up_at, restored.data_time);
});

test("wiki and briefing answer and speech caps count Unicode characters", () => {
  for (const kind of ["wiki", "briefing"]) {
    const bounded = {
      ...snapshot,
      kind,
      answer: `${"अ".repeat(999)}\n${"😀".repeat(1000)}`,
      speech: "😀".repeat(240),
      data_time: "2026-11-03T03:15:00Z",
    };
    assert.equal([...parseLookupResult(bounded).answer].length, 2000);
    assert.equal([...parseLookupResult(bounded).speech].length, 240);
    for (const change of [
      { answer: `${bounded.answer}अ` },
      { speech: `${bounded.speech}😀` },
      { speech: "One line\nonly" },
      { answer: "Not a\tplain answer" },
      { sources: Array(4).fill(snapshot.sources[0]) },
    ])
      assert.throws(() => parseLookupResult({ ...bounded, ...change }), kind);
  }
});

test("provider data cannot add write actions or bypass result and speech caps", () => {
  for (const change of [
    { actions: [{ type: "create_reminder" }] },
    { sources: Array(4).fill(snapshot.sources[0]) },
    { speech: "a".repeat(241) },
    { kind: "draft_email" },
    { looked_up_at: "today" },
    { sources: [{ ...snapshot.sources[0], tool_call: "tavily_extract" }] },
  ])
    assert.throws(() => parseLookupResult({ ...snapshot, ...change }));
});
