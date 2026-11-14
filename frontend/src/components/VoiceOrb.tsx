import { useEffect, useRef } from "react";
import { voiceSignal } from "../lib/voice";
import { cx } from "./ui";

const HALF = 12;
const TAU = Math.PI * 2;

const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const vnoise = (x: number) => {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
};
const fbm = (x: number) => 0.5 * vnoise(x) + 0.3 * vnoise(x * 2.03 + 17.1) + 0.2 * vnoise(x * 4.07 + 5.3);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export type OrbTone = "accent" | "danger" | "ok" | "signal";

function readPalette(tone: OrbTone) {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const colors =
    tone === "danger"
      ? [v("--danger", "#f43f5e"), v("--warn", "#f59e0b"), v("--purple", "#a855f7")]
      : tone === "signal"
      ? [v("--signal", "#06b6d4"), v("--purple", "#a855f7"), v("--accent", "#10b981")]
      : [v("--ok", "#10b981"), v("--accent", "#10b981"), v("--signal", "#06b6d4")];
  return { colors, dark: document.documentElement.classList.contains("dark") };
}

function sampleLevels(now: number, active: boolean, ambient: boolean, levels: Float32Array, bins: Uint8Array, calm: number) {
  const sig = voiceSignal.get();
  const speaking = active && sig.mode !== "idle";
  const live = speaking || (active && ambient);
  const t = (now / 1000) * calm;
  for (let i = 0; i < HALF; i++) {
    let target: number;
    if (speaking && sig.analyser) {
      if (i === 0) sig.analyser.getByteFrequencyData(bins);
      const b = bins[Math.min(bins.length - 1, 1 + Math.floor(i * 1.6))] / 255;
      target = Math.pow(b, 1.35);
    } else if (live) {
      const since = (now - voiceSignal.lastPulseAt()) / 1000;
      const cadence = speaking ? Math.max(Math.exp(-since / 0.2), 0.55 * fbm(t * 3.1)) : 0.25 * fbm(t * 1.3);
      const syllable = 0.78 + 0.22 * Math.sin(t * TAU * 4.2);
      const base = !speaking ? 0.16 : sig.mode === "listening" ? 0.3 : 0.4;
      const tilt = 1 - (i / HALF) * 0.55;
      const n = fbm(t * (1.6 + i * 0.07) + i * 0.73);
      target = clamp01((base + 0.5 * cadence) * syllable * tilt * (0.45 + 0.75 * n));
    } else {
      target = 0.05 + 0.035 * (0.5 + 0.5 * Math.sin(now / 700 + i * 0.6));
    }
    target *= calm < 1 ? 0.6 : 1;
    levels[i] += (target - levels[i]) * (target > levels[i] ? 0.42 : 0.14);
  }
  let sum = 0;
  for (let i = 0; i < HALF; i++) sum += levels[i];
  return sum / HALF;
}

function bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, Math.min(w, h) / 2);
  else ctx.rect(x, y, w, h);
  ctx.fill();
}

function drawBars(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, levels: Float32Array, energy: number, colors: string[], dark: boolean) {
  ctx.globalCompositeOperation = dark ? "lighter" : "source-over";
  for (let layer = 0; layer < 3; layer++) {
    const amp = h * 0.46 * Math.min(1, energy * 1.8) * (1 - layer * 0.26);
    const freq = ((1.3 + layer * 0.55) * TAU) / w;
    const phase = t * (2.2 + layer * 0.9) * (layer % 2 ? -1 : 1);
    ctx.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const taper = Math.sin((Math.PI * x) / w) ** 2;
      const y = h / 2 + amp * taper * Math.sin(x * freq + phase);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = colors[layer];
    ctx.globalAlpha = (dark ? 0.42 : 0.3) - layer * 0.08;
    ctx.lineWidth = 1.4;
    ctx.shadowColor = colors[layer];
    ctx.shadowBlur = dark ? 8 : 0;
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.globalCompositeOperation = "source-over";

  const n = HALF * 2;
  const gap = Math.max(1.5, w * 0.014);
  const bw = (w - gap * (n - 1)) / n;
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, colors[1]);
  grad.addColorStop(0.5, colors[0]);
  grad.addColorStop(1, colors[1]);
  ctx.fillStyle = grad;
  ctx.globalAlpha = 0.95;
  for (let j = 0; j < n; j++) {
    const m = j < HALF ? HALF - 1 - j : j - HALF;
    const bh = Math.max(2, levels[m] * h * 0.92);
    bar(ctx, j * (bw + gap), (h - bh) / 2, bw, bh);
  }
  ctx.globalAlpha = 1;
}

function drawOrb(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, levels: Float32Array, energy: number, colors: string[], dark: boolean) {
  const cxp = w / 2;
  const cyp = h / 2;
  const R = Math.min(w, h) / 2;
  const r0 = R * 0.56;
  ctx.globalCompositeOperation = dark ? "lighter" : "source-over";
  for (let layer = 0; layer < 3; layer++) {
    ctx.beginPath();
    const steps = 72;
    for (let k = 0; k <= steps; k++) {
      const th = (k / steps) * TAU;
      const wob = fbm(Math.cos(th) * 1.4 + Math.sin(th) * 0.9 + t * (0.55 + layer * 0.22) + layer * 9.7);
      const rr = r0 * (1 + 0.05 * layer) + R * 0.2 * (0.25 + energy * 1.4) * wob;
      const x = cxp + rr * Math.cos(th);
      const y = cyp + rr * Math.sin(th);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    const g = ctx.createRadialGradient(cxp, cyp, r0 * 0.55, cxp, cyp, R);
    g.addColorStop(0, colors[layer]);
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.globalAlpha = dark ? 0.26 : 0.16;
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";

  const nb = HALF * 4;
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(2, R * 0.024);
  for (let k = 0; k < nb; k++) {
    const th = -Math.PI / 2 + (k / nb) * TAU;
    const m = k <= nb / 2 ? k : nb - k;
    const lv = levels[Math.min(HALF - 1, Math.floor((m / (nb / 2)) * (HALF - 1)))];
    const inner = r0 * 1.05;
    const len = R * 0.04 + lv * R * 0.34;
    ctx.strokeStyle = colors[k % 2 ? 1 : 0];
    ctx.globalAlpha = 0.55 + lv * 0.45;
    ctx.beginPath();
    ctx.moveTo(cxp + inner * Math.cos(th), cyp + inner * Math.sin(th));
    ctx.lineTo(cxp + (inner + len) * Math.cos(th), cyp + (inner + len) * Math.sin(th));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

export function VoiceOrb({
  variant = "bars",
  active = true,
  ambient = false,
  tone = "accent",
  className,
}: {
  variant?: "bars" | "orb";
  active?: boolean;
  ambient?: boolean;
  tone?: OrbTone;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const ambientRef = useRef(ambient);
  ambientRef.current = ambient;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let w = 0;
    let h = 0;
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = r.width;
      h = r.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.35 : 1;
    const levels = new Float32Array(HALF);
    const bins = new Uint8Array(32);
    let palette = readPalette(tone);
    let frame = 0;
    let raf = 0;
    const draw = (now: number) => {
      if (frame++ % 30 === 0) palette = readPalette(tone);
      const energy = sampleLevels(now, activeRef.current, ambientRef.current, levels, bins, calm);
      ctx.clearRect(0, 0, w, h);
      const t = (now / 1000) * calm;
      if (variant === "orb") drawOrb(ctx, w, h, t, levels, energy, palette.colors, palette.dark);
      else drawBars(ctx, w, h, t, levels, energy, palette.colors, palette.dark);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [variant, tone]);

  return <canvas ref={canvasRef} aria-hidden className={cx("block", className)} />;
}
