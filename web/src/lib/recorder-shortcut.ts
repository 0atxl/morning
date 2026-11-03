export type ShortcutKey = Pick<
  KeyboardEvent,
  | "code"
  | "repeat"
  | "ctrlKey"
  | "altKey"
  | "metaKey"
  | "shiftKey"
  | "isComposing"
  | "defaultPrevented"
> & { getModifierState?: (modifier: string) => boolean };

export function canToggleRecorder(
  phase: string,
  retryAt = 0,
  now = Date.now(),
) {
  return (
    ["ready", "listening", "saved", "clarification", "error"].includes(phase) &&
    now >= retryAt
  );
}

// Own only a fresh, solo physical Right Ctrl press. Other shortcuts keep their
// defaults; adding another key cancels this hold rather than submitting it.
export class RightControlHold {
  private pressed = new Set<string>();
  private holding = false;

  keyDown(event: ShortcutKey, eligible: boolean): "start" | "cancel" | null {
    if (event.code !== "ControlRight") {
      this.pressed.add(event.code);
      const cancel = this.holding;
      this.holding = false;
      return cancel ? "cancel" : null;
    }
    if (event.repeat || this.pressed.has("ControlRight")) return null;
    this.holding = eligible && this.pressed.size === 0 && !this.excluded(event);
    this.pressed.add("ControlRight");
    return this.holding ? "start" : null;
  }

  keyUp(event: ShortcutKey): boolean {
    if (event.code !== "ControlRight") {
      this.pressed.delete(event.code);
      return false;
    }
    const release = this.holding;
    this.holding = false;
    this.pressed.delete("ControlRight");
    return release;
  }

  reset() {
    const cancel = this.holding;
    this.holding = false;
    this.pressed.clear();
    return cancel;
  }

  disown() {
    this.holding = false;
  }

  private excluded(event: ShortcutKey) {
    return (
      event.altKey ||
      event.metaKey ||
      event.shiftKey ||
      event.isComposing ||
      event.defaultPrevented ||
      Boolean(event.getModifierState?.("AltGraph"))
    );
  }
}
