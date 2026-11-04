// Floating dot shapes adapted from the user-provided Morning reference.
export type DotStructureState = "ORB" | "STT" | "PEN" | "MAIL" | "DIAL";

export const W = 46;
export const H = 19;
export const CX = (W - 1) / 2;
export const CY = (H - 1) / 2;
const DOT_GLYPHS = [" ", ".", "·", ":", "•"] as const;

function distToSeg(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}

export function computeDotField(
  state: DotStructureState,
  tick: number,
): number[][] {
  const field = Array.from({ length: H }, () => Array(W).fill(0));
  const t = tick * 0.08;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ax = (x - CX) * 0.52;
      const ay = y - CY;
      let val = 0; // Pure floating object — no rectangular background grid

      if (state === "ORB") {
        const R = 7.8 + Math.sin(t * 1.2) * 0.35;
        const r2 = ax * ax + ay * ay;
        if (r2 <= R * R) {
          const z = Math.sqrt(R * R - r2);
          const nx = ax / R,
            ny = ay / R,
            nz = z / R;
          const rotX = nx * Math.cos(t * 1.4) + nz * Math.sin(t * 1.4);
          const rotZ = -nx * Math.sin(t * 1.4) + nz * Math.cos(t * 1.4);
          const lat = Math.acos(Math.max(-1, Math.min(1, ny)));
          const lon = Math.atan2(rotZ, rotX);
          const gridBand =
            Math.abs(Math.sin(lat * 6)) > 0.72 ||
            Math.abs(Math.sin(lon * 6)) > 0.75
              ? 0.28
              : 0;
          const light = Math.max(0.15, -0.45 * nx - 0.5 * ny + 0.74 * nz);
          const rim = r2 > (R - 0.65) ** 2 ? 0.35 : 0;
          val = Math.min(1, light * 0.75 + gridBand + rim);
        }
      } else if (state === "STT") {
        const dist = Math.hypot(ax, ay);
        if (dist <= 9.2) {
          const waveY =
            Math.sin(ax * 0.85 - t * 3.2) *
            Math.cos(ax * 0.22) *
            (3.2 * Math.sin(t * 1.5 + 1));
          const dWave = Math.abs(ay - waveY);
          const dWave2 = Math.abs(ay - -waveY * 0.6);
          const ring1 = Math.abs(dist - ((t * 2.8) % 9.0));
          const ring2 = Math.abs(dist - ((t * 2.8 + 4.5) % 9.0));
          if (dWave < 0.75) val = Math.max(val, 1.0 - dWave * 0.8);
          if (dWave2 < 0.65) val = Math.max(val, 0.65 - dWave2 * 0.6);
          if (ring1 < 0.45)
            val = Math.max(val, (0.85 - ring1) * (1 - dist / 10));
          if (ring2 < 0.45)
            val = Math.max(val, (0.85 - ring2) * (1 - dist / 10));
        }
      } else if (state === "PEN") {
        const nibX = -4.5 + Math.sin(t * 1.1) * 3.8;
        const nibY = 4.2 + Math.cos(t * 2.2) * 0.45;
        const dirX = 0.72,
          dirY = -0.69;
        const perpX = -dirY,
          perpY = dirX;
        const dx = ax - nibX,
          dy = ay - nibY;
        const along = dx * dirX + dy * dirY;
        const across = Math.abs(dx * perpX + dy * perpY);

        if (along >= 0 && along <= 13.5) {
          const radius = along < 3.2 ? (along / 3.2) * 1.45 : 1.45;
          if (across <= radius) {
            const cylShade = 1.0 - (across / (radius + 0.1)) * 0.65;
            const isCollar =
              Math.abs(along - 3.2) < 0.45 || Math.abs(along - 11.5) < 0.45;
            val = Math.max(val, isCollar ? 1.0 : cylShade);
          }
        }
        if (ax >= -9.5 && ax <= nibX + 0.3) {
          const curveY = 4.5 + Math.sin(ax * 0.75 + t * 1.5) * 1.15;
          if (Math.abs(ay - curveY) < 0.55) {
            val = Math.max(val, Math.max(0.3, 1 - (nibX - ax) / 16));
          }
        }
      } else if (state === "MAIL") {
        const left = -8.2,
          right = 8.2,
          top = -5.2,
          bot = 5.2;
        if (ax >= left && ax <= right && ay >= top && ay <= bot) {
          const dBorder = Math.min(
            Math.abs(ax - left),
            Math.abs(ax - right),
            Math.abs(ay - top),
            Math.abs(ay - bot),
          );
          const dFlapL = distToSeg(ax, ay, left, top, 0, 1.0);
          const dFlapR = distToSeg(ax, ay, right, top, 0, 1.0);
          const dFoldBL = distToSeg(ax, ay, left, bot, -2.8, -0.5);
          const dFoldBR = distToSeg(ax, ay, right, bot, 2.8, -0.5);
          if (dBorder < 0.48 || dFlapL < 0.45 || dFlapR < 0.45) val = 0.96;
          else if (dFoldBL < 0.42 || dFoldBR < 0.42) val = 0.62;
          if (Math.hypot(ax, ay - 1.0) < 1.0 + Math.sin(t * 2.5) * 0.2)
            val = 1.0;
        }
      } else if (state === "DIAL") {
        const R = 7.8;
        const dist = Math.hypot(ax, ay);
        if (Math.abs(dist - R) < 0.48) {
          val = 0.92;
        } else if (dist < R) {
          for (let h = 0; h < 12; h++) {
            const ang = (h * Math.PI) / 6;
            if (
              Math.hypot(
                ax - Math.sin(ang) * (R - 1.2),
                ay - -Math.cos(ang) * (R - 1.2),
              ) < 0.5
            ) {
              val = 0.95;
            }
          }
          const hAng = -Math.PI / 6;
          const dHour = distToSeg(
            ax,
            ay,
            0,
            0,
            Math.sin(hAng) * 4.2,
            -Math.cos(hAng) * 4.2,
          );
          const sweep = Math.min(1, (t * 0.55) % 1.6);
          const ease = 1 - Math.pow(1 - sweep, 3);
          const mAng = Math.PI * (1 - ease);
          const dMin = distToSeg(
            ax,
            ay,
            0,
            0,
            Math.sin(mAng) * 6.2,
            -Math.cos(mAng) * 6.2,
          );
          if (dHour < 0.48 || dMin < 0.45 || dist < 0.75) val = 1.0;
        }
      }

      field[y][x] = val;
    }
  }
  return field;
}

export function fieldToDotAscii(field: number[][]): string {
  return field
    .map((row) =>
      row
        .map((v) => {
          if (v <= 0.1) return DOT_GLYPHS[0];
          if (v < 0.35) return DOT_GLYPHS[1];
          if (v < 0.62) return DOT_GLYPHS[2];
          if (v < 0.85) return DOT_GLYPHS[3];
          return DOT_GLYPHS[4];
        })
        .join(""),
    )
    .join("\n");
}

export function extractDotParticles(field: number[][]) {
  const pts: { x: number; y: number; w: number }[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (field[y][x] > 0.1) pts.push({ x, y, w: field[y][x] });
    }
  }
  return pts;
}
