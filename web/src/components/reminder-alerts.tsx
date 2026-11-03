import { useEffect, useRef, useState } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ownerKey, pairOwnerBrowser } from "@/lib/reminder-alerts";
import {
  acknowledgeReminderMail,
  pollReminders,
  type StoredReminder,
} from "@/lib/reminder-store";

function chime(audio: AudioContext) {
  if (audio.state !== "running") return;
  for (const [offset, frequency] of [
    [0, 660],
    [0.24, 880],
  ]) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const start = audio.currentTime + offset;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.001, start);
    gain.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.42);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(start);
    oscillator.stop(start + 0.44);
  }
}

export function ReminderAlerts() {
  const [alerts, setAlerts] = useState<StoredReminder[]>([]);
  const [mailStatus, setMailStatus] = useState("");
  const [soundError, setSoundError] = useState(false);
  const audio = useRef<AudioContext | null>(null);

  function enableSound() {
    if (typeof AudioContext === "undefined") return;
    try {
      audio.current ??= new AudioContext();
      if (audio.current.state !== "running")
        void audio.current.resume().catch(() => {});
    } catch {
      /* Show the visual alert even when sound is unavailable. */
    }
  }

  useEffect(() => {
    try {
      pairOwnerBrowser();
    } catch {
      setMailStatus("This browser could not enable reminder emails.");
    }
    let active = true;
    let checking = false;
    let queued = false;
    let syncing = false;
    let timer: number;
    let mailBackoff = 0;

    async function check() {
      if (!active) return;
      if (checking) {
        queued = true;
        return;
      }
      checking = true;
      let next = Date.now() + 30_000;
      try {
        const batch = await pollReminders(Date.now());
        if (!active) return;
        next = batch.next;
        if (batch.due.length) {
          setAlerts((previous) => [...previous, ...batch.due]);
          if (audio.current?.state === "running") chime(audio.current);
        }
        const key = ownerKey();
        if (
          key &&
          batch.pending.length &&
          !syncing &&
          Date.now() >= mailBackoff
        ) {
          syncing = true;
          setMailStatus("Scheduling reminder email…");
          void (async () => {
            try {
              for (const job of batch.pending) {
                const response = await fetch("/api/reminder-email", {
                  method: "POST",
                  keepalive: true,
                  headers: {
                    Authorization: "Bearer " + key,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify(job),
                  signal: AbortSignal.timeout(12_000),
                });
                if (!response.ok) throw new Error();
                await acknowledgeReminderMail(job);
              }
              if (active) setMailStatus("Reminder email scheduled.");
            } catch {
              mailBackoff = Date.now() + 30_000;
              if (active)
                setMailStatus(
                  "Email scheduling is pending. Keep Morning open to retry.",
                );
            } finally {
              syncing = false;
              if (active) wake();
            }
          })();
        }
      } catch {
        /* Retry storage when a blocked tab closes or storage returns. */
      } finally {
        checking = false;
        if (active) {
          window.clearTimeout(timer);
          timer = window.setTimeout(
            check,
            queued
              ? 0
              : Math.max(
                  0,
                  Math.min(
                    next - Date.now(),
                    mailBackoff > Date.now()
                      ? mailBackoff - Date.now()
                      : 60_000,
                  ),
                ),
          );
          queued = false;
        }
      }
    }
    function wake() {
      window.clearTimeout(timer);
      timer = window.setTimeout(check, 0);
    }
    wake();
    window.addEventListener("morning-reminder-change", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("pointerdown", enableSound);
    window.addEventListener("keydown", enableSound);
    return () => {
      active = false;
      window.clearTimeout(timer);
      window.removeEventListener("morning-reminder-change", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("pointerdown", enableSound);
      window.removeEventListener("keydown", enableSound);
      void audio.current?.close().catch(() => {});
      audio.current = null;
    };
  }, []);

  async function ring() {
    try {
      enableSound();
      if (!audio.current) throw new Error();
      await audio.current.resume();
      chime(audio.current);
      setSoundError(false);
    } catch {
      setSoundError(true);
    }
  }
  return (
    <>
      {mailStatus && (
        <p role="status" className="text-sm">
          {mailStatus}
        </p>
      )}
      {alerts.length > 0 && (
        <Alert>
          <AlertTitle>Reminder due</AlertTitle>
          <ul>
            {alerts.map((item) => (
              <li key={item.id + item.dueAt}>{item.title}</li>
            ))}
          </ul>
          <Button variant="ghost" size="sm" onClick={() => void ring()}>
            Play chime
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setAlerts([]);
              setSoundError(false);
            }}
          >
            Dismiss
          </Button>
          {soundError && <p>Sound is unavailable on this device.</p>}
        </Alert>
      )}
    </>
  );
}
