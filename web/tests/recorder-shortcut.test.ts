import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canToggleRecorder,
  RightControlHold,
  type ShortcutKey,
} from "../src/lib/recorder-shortcut.ts";

// Definitions only. No mic, DOM or provider is used by these cases.
const key = (
  code = "ControlRight",
  overrides: Partial<ShortcutKey> = {},
): ShortcutKey => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  repeat: false,
  isComposing: false,
  defaultPrevented: false,
  ...overrides,
});
const press = (overrides: Partial<ShortcutKey> = {}) =>
  key("ControlRight", { ctrlKey: true, ...overrides });

test("push-to-talk starts on keydown and releases once on keyup", () => {
  const hold = new RightControlHold();
  assert.equal(hold.keyDown(press(), true), "start");
  assert.equal(hold.keyUp(key()), true);
  assert.equal(hold.keyUp(key()), false);
  assert.equal(hold.keyDown(press(), true), "start");
  assert.equal(hold.keyUp(key()), true);
});

test("left Ctrl and keys without a physical Right Ctrl code never start", () => {
  for (const code of ["ControlLeft", ""]) {
    const hold = new RightControlHold();
    assert.equal(hold.keyDown(key(code, { ctrlKey: true }), true), null);
    assert.equal(hold.keyUp(key(code)), false);
  }
});

test("an already held shortcut key blocks capture, including Ctrl+C", () => {
  for (const code of [
    "KeyC",
    "ControlLeft",
    "ShiftLeft",
    "AltLeft",
    "MetaLeft",
  ]) {
    const hold = new RightControlHold();
    hold.keyDown(key(code), true);
    assert.equal(hold.keyDown(press(), true), null);
    hold.keyUp(key(code));
    assert.equal(hold.keyUp(key()), false);
  }
});

test("forming a chord during a hold cancels it without a release submission", () => {
  const hold = new RightControlHold();
  assert.equal(hold.keyDown(press(), true), "start");
  assert.equal(hold.keyDown(key("KeyC", { ctrlKey: true }), true), "cancel");
  assert.equal(hold.keyUp(key("KeyC")), false);
  assert.equal(hold.keyUp(key()), false);
});

test("repeated keydown events neither start twice nor create another release", () => {
  const hold = new RightControlHold();
  assert.equal(hold.keyDown(press({ repeat: true }), true), null);
  assert.equal(hold.keyUp(key()), false);
  assert.equal(hold.keyDown(press(), true), "start");
  assert.equal(hold.keyDown(press({ repeat: true }), true), null);
  assert.equal(hold.keyDown(press(), true), null);
  assert.equal(hold.keyUp(key()), true);
  assert.equal(hold.keyUp(key()), false);
});

test("editors, dialogs, busy states and pointer-owned capture cannot acquire a hold", () => {
  const hold = new RightControlHold();
  assert.equal(hold.keyDown(press(), false), null);
  assert.equal(hold.keyUp(key()), false);
  // A lifecycle that refused ownership cannot be stopped by this key release.
  assert.equal(hold.keyDown(press(), true), "start");
  hold.disown();
  assert.equal(hold.keyUp(key()), false);
});

test("release still arrives during startup or after the event target changes", () => {
  const hold = new RightControlHold();
  assert.equal(hold.keyDown(press(), true), "start");
  // Eligibility only gates acquisition. Release must reach the owning lifecycle
  // even while permission or WebSocket startup makes starting ineligible.
  assert.equal(
    hold.keyUp(key("ControlRight", { defaultPrevented: true })),
    true,
  );
  assert.equal(hold.keyUp(key()), false);
});

test("blur cancels an owned hold once and a late keyup cannot submit it", () => {
  const hold = new RightControlHold();
  hold.keyDown(press(), true);
  assert.equal(hold.reset(), true);
  assert.equal(hold.reset(), false);
  assert.equal(hold.keyUp(key()), false);
  assert.equal(hold.keyDown(press(), true), "start");
});

test("modifier flags, IME, prevented keys and AltGraph block acquisition", () => {
  for (const flags of [
    { altKey: true },
    { metaKey: true },
    { shiftKey: true },
    { isComposing: true },
    { defaultPrevented: true },
    { getModifierState: (name: string) => name === "AltGraph" },
  ]) {
    const hold = new RightControlHold();
    assert.equal(hold.keyDown(press(flags), true), null);
    assert.equal(hold.keyUp(key()), false);
  }
});

test("the shared guard blocks busy phases and rate-limit cooldown", () => {
  for (const phase of [
    "loading",
    "requesting",
    "connecting",
    "finishing",
    "processing",
    "saving",
    "unknown",
  ])
    assert.equal(canToggleRecorder(phase), false);
  for (const phase of ["ready", "listening", "saved", "clarification", "error"])
    assert.equal(canToggleRecorder(phase), true);
  assert.equal(canToggleRecorder("error", 2000, 1999), false);
  assert.equal(canToggleRecorder("error", 2000, 2000), true);
});
