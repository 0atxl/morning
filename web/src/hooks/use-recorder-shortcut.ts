import { useEffect, useEffectEvent } from "react";
import { RightControlHold } from "@/lib/recorder-shortcut";

const edits =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="spinbutton"]';

export function useRecorderShortcut(
  onStart: () => boolean,
  onRelease: () => void,
  onCancel: () => void,
  enabled: () => boolean,
) {
  const start = useEffectEvent(onStart);
  const release = useEffectEvent(onRelease);
  const cancel = useEffectEvent(onCancel);
  const eligible = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    return (
      enabled() &&
      document.hasFocus() &&
      document.visibilityState !== "hidden" &&
      !target?.closest(edits) &&
      !document.activeElement?.closest(edits) &&
      !document.querySelector(
        '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]',
      )
    );
  });

  useEffect(() => {
    const hold = new RightControlHold();
    const down = (event: KeyboardEvent) => {
      const action = hold.keyDown(event, eligible(event));
      if (action === "start" && !start()) hold.disown();
      if (action === "cancel") cancel();
    };
    const up = (event: KeyboardEvent) => {
      // Release even if focus moved into an editor or a busy phase began.
      if (hold.keyUp(event)) release();
    };
    const reset = () => {
      if (hold.reset()) cancel();
    };
    // Capture observes chords even if an editor or popover stops propagation.
    // No keydown or non-shortcut default action is prevented, including Ctrl+C.
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", reset);
    document.addEventListener("compositionstart", reset);
    return () => {
      reset();
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", reset);
      document.removeEventListener("compositionstart", reset);
    };
  }, []);
}
