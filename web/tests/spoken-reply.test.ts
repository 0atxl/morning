import assert from "node:assert/strict";
import { test } from "node:test";
import { SpokenReply } from "../src/lib/spoken-reply.ts";

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
