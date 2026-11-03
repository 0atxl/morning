import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  computeDotField,
  fieldToDotAscii,
  extractDotParticles,
  W,
  H,
  CX,
  CY,
  type DotStructureState,
} from "@/lib/dot-field";

function subscribeMotion(change: () => void) {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", change);
  document.addEventListener("visibilitychange", change);
  return () => {
    media.removeEventListener("change", change);
    document.removeEventListener("visibilitychange", change);
  };
}
const motionEnabled = () =>
  !window.matchMedia("(prefers-reduced-motion: reduce)").matches &&
  document.visibilityState !== "hidden";
const noMotion = () => false;

function useMotionEnabled() {
  return useSyncExternalStore(subscribeMotion, motionEnabled, noMotion);
}

export function ExecutionDotMorph({
  state,
  running,
}: {
  state: DotStructureState;
  running: boolean;
}) {
  const motion = useMotionEnabled() && running;
  const field = useRef<number[][]>([]);
  if (!field.current.length) field.current = computeDotField(state, 120);
  const tick = useRef(120);
  const [ascii, setAscii] = useState(() => fieldToDotAscii(field.current));

  useEffect(() => {
    if (!motion) {
      field.current = computeDotField(state, 120);
      setAscii(fieldToDotAscii(field.current));
      return;
    }
    // Retarget from the current drawing when another real event interrupts it.
    const from = extractDotParticles(field.current);
    let progress = 0;
    const timer = window.setInterval(() => {
      tick.current++;
      const target = computeDotField(state, tick.current);
      progress = Math.min(1, progress + 0.2);
      if (progress === 1) field.current = target;
      else {
        const to = extractDotParticles(target);
        const next: number[][] = Array.from({ length: H }, () =>
          Array(W).fill(0),
        );
        for (let i = 0; i < Math.max(from.length, to.length); i++) {
          const a = from[i % from.length] ?? { x: CX, y: CY, w: 0.5 };
          const b = to[i % to.length] ?? { x: CX, y: CY, w: 0.5 };
          let x: number, y: number, weight: number;
          if (progress < 0.42) {
            const ease = (progress / 0.42) ** 2;
            const angle = ease * 1.35;
            const dx = (a.x - CX) * (1 - ease * 0.86);
            const dy = (a.y - CY) * (1 - ease * 0.86);
            x = Math.round(CX + dx * Math.cos(angle) - dy * Math.sin(angle));
            y = Math.round(CY + dx * Math.sin(angle) + dy * Math.cos(angle));
            weight = a.w * (1 - ease * 0.25);
          } else {
            const p = (progress - 0.42) / 0.58;
            const ease = 1 - (1 - p) ** 3;
            x = Math.round(CX + (b.x - CX) * ease);
            y = Math.round(CY + (b.y - CY) * ease);
            weight = b.w;
          }
          if (y >= 0 && y < H && x >= 0 && x < W)
            next[y][x] = Math.max(next[y][x], weight);
        }
        field.current = next;
      }
      setAscii(fieldToDotAscii(field.current));
    }, 55);
    return () => window.clearInterval(timer);
  }, [state, motion]);

  return (
    <pre
      aria-hidden="true"
      className="execution-dot-canvas font-mono text-xs leading-none tracking-[0.08em] select-none whitespace-pre text-center"
    >
      {ascii}
    </pre>
  );
}

const wave = [
  ". · : • : · .",
  "· : • : · . ·",
  ": • : · . · :",
  "• : · . · : •",
];
const ramp = ["•", ":", "·", ".", ".", " "];

export function UnderOrbDotTranscript({
  text,
  isTranscribing,
  fallback,
}: {
  text: string;
  isTranscribing: boolean;
  fallback: string;
}) {
  const motion = useMotionEnabled();
  const [reveal, setReveal] = useState({ text, count: 8 });
  const [waveFrame, setWaveFrame] = useState(0);
  useEffect(() => {
    if (!motion || !isTranscribing || !text) return;
    setReveal({ text, count: 0 });
    let count = 0;
    const timer = window.setInterval(() => {
      count += 2;
      setReveal({ text, count });
      if (count >= 8) window.clearInterval(timer);
    }, 55);
    return () => window.clearInterval(timer);
  }, [text, isTranscribing, motion]);
  useEffect(() => {
    if (!motion || !isTranscribing) return;
    const timer = window.setInterval(
      () => setWaveFrame((frame) => (frame + 1) % wave.length),
      165,
    );
    return () => window.clearInterval(timer);
  }, [motion, isTranscribing]);
  const chars = Array.from(text);
  const count = reveal.text === text ? reveal.count : 0;
  const tailStart = Math.max(0, chars.length - 8);
  const rendered =
    motion && isTranscribing
      ? chars
          .map((char, index) => {
            const offset = index - tailStart;
            return offset < 0 || offset < count || /\s/.test(char)
              ? char
              : ramp[Math.min(5, Math.floor((offset / 8) * 6))];
          })
          .join("")
      : text;

  return (
    <div className="under-orb-transcript">
      <div className="dot-wave font-mono" aria-hidden="true">
        {isTranscribing ? wave[motion ? waveFrame : 0] : "\u00a0"}
      </div>
      <p id="command-transcript" className="sr-only">
        {text || fallback}
      </p>
      <p
        aria-hidden="true"
        className={`transcript font-mono${!text ? " transcript-idle" : ""}`}
      >
        {rendered || fallback}
      </p>
    </div>
  );
}
