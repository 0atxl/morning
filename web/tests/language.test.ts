import assert from "node:assert/strict";
import { test } from "node:test";
import { clarificationTarget, speechLanguage } from "../src/lib/language.ts";
import {
  parseCommandResponse,
  voiceToken,
  type CommandRequest,
} from "../src/lib/command-api.ts";
import { confirmationText, SpokenReply } from "../src/lib/spoken-reply.ts";

const request: CommandRequest = {
  command_id: "hindi-turn",
  transcript: "Pune mein mausam?",
  now: "2026-11-03T09:00:00+05:30",
  timezone: "Asia/Kolkata",
};

test("the voice grant accepts only the configured multilingual Deepgram URL", async (t) => {
  let language = "multi&language_hint=en&language_hint=hi";
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      access_token: "fixture",
      expires_in: 30,
      websocket_url: `wss://api.deepgram.com/v1/listen?model=nova-3&language=${language}&interim_results=true&smart_format=true`,
    }),
  );
  assert.match(
    (await voiceToken(new AbortController().signal)).url,
    /language=multi/,
  );
  language = "en-US";
  await assert.rejects(voiceToken(new AbortController().signal));
});

test("Hindi clarification preserves the pending query language and picker target", () => {
  const response = parseCommandResponse(
    {
      command_id: request.command_id,
      actions: [],
      clarification: "कौन सा शहर या जगह?",
      reply_language: "hi",
      lookup_context: {
        query: { kind: "hotels", terms: "", place: "", today: false },
        reply_language: "hi",
      },
    },
    request,
  );
  assert.equal(response.replyLanguage, "hi");
  assert.equal(response.kind, "clarification");
  if (response.kind === "clarification")
    assert.equal(response.lookupContext?.reply_language, "hi");
  assert.equal(clarificationTarget("कौन सा रिमाइंडर बदलना है?"), "reminder");
  assert.equal(clarificationTarget("कौन सा ईमेल ड्राफ्ट बदलना है?"), "draft");
  assert.equal(clarificationTarget("कौन सा संपर्क चुनूँ?"), "contact");
  assert.equal(speechLanguage("रिमाइंडर सेव हो गया।"), "hi");
});

test("Hindi confirmation uses the committed reminder time", () => {
  const text = confirmationText(
    [
      {
        id: "reminder",
        kind: "reminder",
        title: "पानी पीना",
        transcript: "मुझे दस मिनट में पानी पीने की याद दिलाना",
        dueAt: "2026-11-03T09:10:00+05:30",
        timezone: "Asia/Kolkata",
      },
    ],
    undefined,
    "hi",
  );
  assert.match(text, /रिमाइंडर सेव/);
  assert.match(text, /9:10/);
  assert.ok([...text].length <= 240);
});

test("Hindi speech requests only synthesis and selects a Hindi browser fallback", async (t) => {
  const paths: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (path: string, init: RequestInit) => {
      paths.push(path);
      assert.deepEqual(JSON.parse(String(init.body)), {
        text: "रिमाइंडर सेव हो गया।",
        language: "hi",
      });
      return new Response(null, { status: 503 });
    },
  );
  let spoken: UtteranceStub | undefined;
  class UtteranceStub {
    lang = "";
    voice?: unknown;
    onstart?: () => void;
    onend?: () => void;
  }
  const voice = { lang: "hi-IN", name: "fixture Hindi" };
  const originals = ["window", "SpeechSynthesisUtterance"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout,
      clearTimeout,
      speechSynthesis: {
        getVoices: () => [voice],
        cancel: () => {},
        speak: (utterance: UtteranceStub) => {
          spoken = utterance;
          utterance.onstart?.();
          utterance.onend?.();
        },
      },
    },
  });
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    configurable: true,
    value: UtteranceStub,
  });
  const reply = new SpokenReply("रिमाइंडर सेव हो गया।", () => {}, "hi");
  t.after(() => {
    reply.stop();
    for (const [key, value] of originals) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await reply.start();
  reply.play();
  assert.equal(spoken?.lang, "hi-IN");
  assert.equal(spoken?.voice, voice);
  assert.deepEqual(paths, ["/api/speech"]);
});
