import assert from "node:assert/strict";
import { test } from "node:test";
import { SpokenReply } from "../src/lib/spoken-reply.ts";

test("a manual browser reply supersedes an automatic MP3 request still in flight", async (t) => {
  let resolveAudio!: (response: Response) => void;
  t.mock.method(
    globalThis,
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        resolveAudio = resolve;
      }),
  );
  let utterance: { onstart?: () => void; onend?: () => void };
  let audioInstances = 0;
  class UtteranceStub {
    lang = "";
    onstart?: () => void;
    onend?: () => void;
    onerror?: () => void;
  }
  class AudioStub {
    constructor() {
      audioInstances++;
    }
  }
  const originals = ["window", "SpeechSynthesisUtterance", "Audio"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout,
      clearTimeout,
      speechSynthesis: {
        speak: (value: UtteranceStub) => {
          utterance = value;
          value.onstart?.();
        },
        cancel: () => {},
      },
    },
  });
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    configurable: true,
    value: UtteranceStub,
  });
  Object.defineProperty(globalThis, "Audio", {
    configurable: true,
    value: AudioStub,
  });
  const states: string[] = [];
  const reply = new SpokenReply("Reminder updated.", (state) =>
    states.push(state),
  );
  t.after(() => {
    reply.stop();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const automatic = reply.start();
  reply.play();
  resolveAudio(
    new Response(new Blob(["fixture"]), {
      headers: { "Content-Type": "audio/mpeg" },
    }),
  );
  await automatic;
  assert.deepEqual(states, ["speaking"]);
  assert.equal(audioInstances, 0);
  utterance!.onend?.();
});

// A blocked auto-play must leave a click path that needs no further request.
test("Play reply reuses the saved MP3 and reports Speaking only on playback", async (t) => {
  const states: string[] = [];
  const requests: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (path: string, init: RequestInit) => {
      requests.push(path);
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(String(init.body)), { text: "Draft saved." });
      return new Response(new Blob(["fixture"]), {
        headers: { "Content-Type": "audio/mpeg" },
      });
    },
  );

  let attempts = 0;
  let player: AudioStub;
  class AudioStub {
    onplaying?: () => void;
    onended?: () => void;
    play() {
      player = this;
      if (++attempts === 1)
        return Promise.reject(
          new DOMException("Gesture required", "NotAllowedError"),
        );
      return Promise.resolve();
    }
    pause() {}
    load() {}
    removeAttribute() {}
  }
  Object.defineProperty(globalThis, "Audio", {
    value: AudioStub,
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: { setTimeout, clearTimeout },
    configurable: true,
  });
  t.after(() => {
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "Audio");
  });

  const reply = new SpokenReply("Draft saved.", (state) => states.push(state));
  t.after(() => reply.stop());
  await reply.start();
  assert.deepEqual(states, ["blocked"]);
  reply.play();
  assert.equal(attempts, 2);
  assert.deepEqual(states, ["blocked"]);
  player!.onplaying?.();
  player!.onended?.();
  assert.deepEqual(states, ["blocked", "speaking", "finished"]);
  assert.deepEqual(requests, ["/api/speech"]);
});

test("a late speech response after cleanup never starts audio", async (t) => {
  let resolveResponse!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  t.mock.method(globalThis, "fetch", () => response);
  const states: string[] = [];
  const reply = new SpokenReply("Draft saved.", (state) => states.push(state));
  const started = reply.start();
  reply.stop();
  resolveResponse(new Response(null, { status: 503 }));
  await started;
  assert.deepEqual(states, []);
});

test("after a gateway error, Play reply retries only speech and explains both failures", async (t) => {
  const requests: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (path: string, init: RequestInit) => {
      requests.push(path);
      assert.deepEqual(JSON.parse(String(init.body)), { text: "Draft saved." });
      return requests.length === 1
        ? new Response("<html>Bad gateway</html>", {
            status: 502,
            headers: { "Content-Type": "text/html" },
          })
        : new Response(null, {
            status: 502,
            headers: { "X-Morning-Speech-Provider-Status": "401" },
          });
    },
  );
  Object.defineProperty(globalThis, "window", {
    value: {},
    configurable: true,
  });
  t.after(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  const errors: string[] = [];
  const reply = new SpokenReply("Draft saved.", (state, message) => {
    assert.equal(state, "blocked");
    errors.push(message!);
  });
  t.after(() => reply.stop());
  await reply.start();
  reply.play();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, ["/api/speech", "/api/speech"]);
  assert.deepEqual(errors, [
    "The speech request returned HTTP 502. This browser has no speech synthesizer.",
    "ElevenLabs returned HTTP 401. This browser has no speech synthesizer.",
  ]);
});
