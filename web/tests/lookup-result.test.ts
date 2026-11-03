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

test("a weather snapshot requires local data time and timezone", () => {
  const weather = {
    kind: "weather",
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
  assert.equal(parseLookupResult(weather).data_time, weather.data_time);
  assert.throws(() => parseLookupResult({ ...weather, data_time: undefined }));
  assert.throws(() =>
    parseLookupResult({ ...weather, timezone: "Invented/Zone" }),
  );
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
