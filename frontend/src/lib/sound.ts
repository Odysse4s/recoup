import { useSyncExternalStore } from "react";

/* ---------------------------------------------------------------------------
   Recoup procedural sound engine — zero-dependency Web Audio synthesis.

   Signal chain (every voice):
     voice → bus → master (0.22) → warm low-pass (4.2 kHz, Q 0.7) ─┬─ dry ───────────────┐
                                                                   ├─ 18/27 ms ping-pong ─┼→ soft limiter → out
                                                                   └─ small generated room┘
   Rules: sine / triangle oscillators and band-limited pink noise only; every voice ramps
   0.0001 → peak linearly over 4–12 ms, decays exponentially back to 0.0001, then stops
   20 ms later — so nothing ever starts or stops at non-zero gain (no clicks or pops).
   --------------------------------------------------------------------------- */

type Wave = "sine" | "triangle";
type FreqPoint = readonly [freq: number, time: number];

interface FilterSpec {
  type: BiquadFilterType;
  q?: number;
  sweep: FreqPoint[];
}

interface ToneSpec {
  freq: number;
  at?: number;
  type?: Wave;
  peak: number;
  attack?: number;
  decay: number;
  pan?: number;
  detune?: number;
  glide?: FreqPoint[];
  swell?: { level: number; time: number };
  filter?: FilterSpec;
}

interface NoiseSpec {
  at?: number;
  peak: number;
  attack?: number;
  decay: number;
  pan?: number;
  filter: FilterSpec;
}

const STORAGE_KEY = "recoup.sfxEnabled";
const MASTER_GAIN = 0.22;
const FLOOR = 0.0001;
const NOISE_MAKEUP = 6;
const PENTATONIC = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const jitter = (amount: number) => 1 + (Math.random() * 2 - 1) * amount;

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

type AudioCtor = typeof AudioContext;

class SoundEngine {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private enabled = readEnabled();
  private resuming = false;
  private pulse = 0;
  private lastPulseAt = 0;
  private lastPlayed = new Map<string, number>();
  private listeners = new Set<() => void>();

  unlock = () => {
    if (!this.ctx) {
      const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      if (!Ctor) return;
      try {
        this.ctx = new Ctor({ latencyHint: "interactive" });
        this.build(this.ctx);
      } catch {
        this.ctx = null;
        return;
      }
    }
    if (this.ctx.state === "suspended" && !this.resuming) {
      this.resuming = true;
      this.ctx
        .resume()
        .catch(() => undefined)
        .finally(() => {
          this.resuming = false;
        });
    }
  };

  private build(ctx: AudioContext) {
    const bus = ctx.createGain();
    const master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    const warm = ctx.createBiquadFilter();
    warm.type = "lowpass";
    warm.frequency.value = 4200;
    warm.Q.value = 0.7;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.knee.value = 10;
    limiter.ratio.value = 3.5;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.2;

    bus.connect(master).connect(warm);
    warm.connect(limiter);

    const wet = ctx.createGain();
    wet.gain.value = 0.12;
    const tapL = ctx.createDelay(0.1);
    const tapR = ctx.createDelay(0.1);
    tapL.delayTime.value = 0.018;
    tapR.delayTime.value = 0.027;
    const damp = ctx.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = 2800;
    const fbL = ctx.createGain();
    const fbR = ctx.createGain();
    fbL.gain.value = 0.32;
    fbR.gain.value = 0.3;
    warm.connect(tapL);
    warm.connect(tapR);
    tapL.connect(damp).connect(fbL).connect(tapR);
    tapR.connect(fbR).connect(tapL);
    this.pan(ctx, tapL, -0.65).connect(wet);
    this.pan(ctx, tapR, 0.65).connect(wet);
    wet.connect(limiter);

    const room = ctx.createConvolver();
    room.buffer = this.impulse(ctx, 0.9);
    const roomGain = ctx.createGain();
    roomGain.gain.value = 0.09;
    warm.connect(room).connect(roomGain).connect(limiter);

    limiter.connect(ctx.destination);
    this.bus = bus;
    this.noiseBuffer = this.pinkNoise(ctx, 1.5);
  }

  private pan(ctx: AudioContext, node: AudioNode, value: number): AudioNode {
    if (!value || typeof ctx.createStereoPanner !== "function") return node;
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(value, -1, 1);
    node.connect(p);
    return p;
  }

  private impulse(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        lp += 0.18 * (Math.random() * 2 - 1 - lp);
        data[i] = lp * Math.pow(1 - t, 3) * (i < 64 ? i / 64 : 1);
      }
    }
    return buf;
  }

  private pinkNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
    return buf;
  }

  private envelope(g: AudioParam, t: number, peak: number, attack: number, decay: number, swell?: ToneSpec["swell"]) {
    const a = clamp(attack, 0.004, 0.012);
    g.setValueAtTime(FLOOR, t);
    g.linearRampToValueAtTime(Math.max(FLOOR * 2, peak), t + a);
    if (swell) g.linearRampToValueAtTime(Math.max(FLOOR * 2, swell.level), t + a + swell.time);
    const end = t + a + decay;
    g.exponentialRampToValueAtTime(FLOOR, end);
    return end;
  }

  private filter(ctx: AudioContext, spec: FilterSpec, t: number): BiquadFilterNode {
    const f = ctx.createBiquadFilter();
    f.type = spec.type;
    f.Q.value = spec.q ?? 0.8;
    const [first, ...rest] = spec.sweep;
    f.frequency.setValueAtTime(first[0], t);
    for (const [hz, time] of rest) f.frequency.exponentialRampToValueAtTime(Math.max(20, hz), t + time);
    return f;
  }

  private tone(ctx: AudioContext, t0: number, s: ToneSpec) {
    const t = t0 + (s.at ?? 0);
    const osc = ctx.createOscillator();
    osc.type = s.type ?? "sine";
    osc.frequency.setValueAtTime(s.freq, t);
    for (const [hz, time] of s.glide ?? []) osc.frequency.exponentialRampToValueAtTime(hz, t + time);
    if (s.detune) osc.detune.value = s.detune;
    const g = ctx.createGain();
    const end = this.envelope(g.gain, t, s.peak, s.attack ?? 0.006, s.decay, s.swell);
    let node: AudioNode = osc;
    if (s.filter) node = node.connect(this.filter(ctx, s.filter, t));
    node.connect(g);
    const out = this.pan(ctx, g, s.pan ?? 0);
    out.connect(this.bus!);
    osc.start(t);
    osc.stop(end + 0.02);
    osc.onended = () => {
      g.disconnect();
      out.disconnect();
    };
  }

  private noise(ctx: AudioContext, t0: number, s: NoiseSpec) {
    if (!this.noiseBuffer) return;
    const t = t0 + (s.at ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const g = ctx.createGain();
    const end = this.envelope(g.gain, t, s.peak, s.attack ?? 0.004, s.decay);
    const makeup = ctx.createGain();
    makeup.gain.value = NOISE_MAKEUP;
    src.connect(this.filter(ctx, s.filter, t)).connect(g).connect(makeup);
    const out = this.pan(ctx, makeup, s.pan ?? 0);
    out.connect(this.bus!);
    src.start(t, Math.random() * 0.8);
    src.stop(end + 0.02);
    src.onended = () => {
      makeup.disconnect();
      out.disconnect();
    };
  }

  private play(name: string, gapMs: number, fn: (ctx: AudioContext, t: number) => void, pulse = true) {
    const ctx = this.ctx;
    if (!this.enabled || !ctx || !this.bus || document.hidden) return;
    if (ctx.state !== "running" && !this.resuming) return;
    const now = performance.now();
    if (now - (this.lastPlayed.get(name) ?? -Infinity) < gapMs) return;
    this.lastPlayed.set(name, now);
    try {
      fn(ctx, ctx.currentTime + 0.006);
    } catch {
      return;
    }
    if (pulse && now - this.lastPulseAt > 90) {
      this.lastPulseAt = now;
      this.pulse += 1;
      this.emit();
    }
  }

  playStageTick = (stageIndex: number) => {
    const i = clamp(Math.round(stageIndex), 0, PENTATONIC.length - 1);
    const f = PENTATONIC[i];
    const pan = -0.7 + (1.4 * i) / (PENTATONIC.length - 1);
    this.play("stage", 70, (ctx, t) => {
      this.tone(ctx, t, { freq: f, peak: 0.55, attack: 0.004, decay: 0.09, pan });
      this.tone(ctx, t, { freq: f * 2, peak: 0.1, attack: 0.004, decay: 0.06, pan, detune: 3 });
      this.tone(ctx, t, { freq: f * 3.98, peak: 0.045, attack: 0.004, decay: 0.035, pan });
      this.tone(ctx, t, { freq: f / 2, type: "triangle", peak: 0.08, attack: 0.006, decay: 0.12, pan });
    });
  };

  playKeyTick = (lineIndex = 0) => {
    this.play(
      "key",
      45,
      (ctx, t) => {
        const centre = (1800 + Math.random() * 600) * jitter(0.04) * (lineIndex % 2 ? 1.02 : 0.98);
        this.noise(ctx, t, {
          peak: 0.04,
          attack: 0.004,
          decay: 0.006,
          pan: (Math.random() * 2 - 1) * 0.25,
          filter: { type: "bandpass", q: 1.6, sweep: [[centre, 0]] },
        });
      },
      false
    );
  };

  playWindowPop = () => {
    this.play("pop", 90, (ctx, t) => {
      const lp: FilterSpec = { type: "lowpass", q: 0.9, sweep: [[700, 0], [2200, 0.11]] };
      this.tone(ctx, t, { freq: 180, glide: [[520, 0.11]], peak: 0.42, attack: 0.012, decay: 0.15, filter: lp });
      this.tone(ctx, t, { freq: 360, glide: [[1040, 0.11]], type: "triangle", peak: 0.06, attack: 0.012, decay: 0.12, filter: lp });
      this.noise(ctx, t, {
        peak: 0.05,
        attack: 0.012,
        decay: 0.12,
        filter: { type: "bandpass", q: 0.8, sweep: [[500, 0], [2600, 0.12]] },
      });
    });
  };

  playWindowDock = () => {
    this.play("dock", 90, (ctx, t) => {
      this.tone(ctx, t, { freq: 140, glide: [[68, 0.095]], peak: 0.75, attack: 0.004, decay: 0.16 });
      this.tone(ctx, t, { freq: 880, peak: 0.16, attack: 0.004, decay: 0.04 });
      this.tone(ctx, t, { freq: 1760, peak: 0.05, attack: 0.004, decay: 0.025 });
      this.noise(ctx, t, { peak: 0.07, attack: 0.004, decay: 0.05, filter: { type: "lowpass", q: 0.7, sweep: [[900, 0]] } });
    });
  };

  playForgeStart = () => {
    this.play("forge_start", 250, (ctx, t) => {
      // Two rhythmic blacksmith hammer-on-anvil strikes (t=0 and t=0.22s)
      const strikes = [
        { at: 0, pan: -0.2, gainMul: 1.0 },
        { at: 0.22, pan: 0.2, gainMul: 1.15 },
      ];
      const partials = [
        { freq: 790, peak: 0.46, decay: 0.38 },
        { freq: 1185, peak: 0.36, decay: 0.35 },
        { freq: 1760, peak: 0.24, decay: 0.30 },
        { freq: 2540, peak: 0.16, decay: 0.25 },
      ];

      strikes.forEach(({ at, pan, gainMul }) => {
        // Sharp bandpass transient impact (2600Hz, Q=4.5)
        this.noise(ctx, t, {
          at,
          peak: 0.22 * gainMul,
          attack: 0.003,
          decay: 0.045,
          pan,
          filter: { type: "bandpass", q: 4.5, sweep: [[2600, 0]] },
        });

        // Inharmonic metallic bell partials
        partials.forEach((p) => {
          this.tone(ctx, t, {
            freq: p.freq,
            at,
            type: "sine",
            peak: p.peak * gainMul,
            attack: 0.004,
            decay: p.decay,
            pan,
          });
          this.tone(ctx, t, {
            freq: p.freq,
            at,
            type: "triangle",
            peak: p.peak * 0.25 * gainMul,
            attack: 0.004,
            decay: p.decay * 0.7,
            pan,
            detune: 5,
          });
        });
      });
    });
  };

  playForgePass = () => {
    this.play("forge_pass", 350, (ctx, t) => {
      // Decisive final metallic anvil ring
      const partials = [
        { freq: 790, peak: 0.52, decay: 0.44 },
        { freq: 1185, peak: 0.40, decay: 0.42 },
        { freq: 1760, peak: 0.28, decay: 0.38 },
        { freq: 2540, peak: 0.20, decay: 0.35 },
      ];
      // Bright octave shimmer
      const shimmer = [
        { freq: 1580, peak: 0.18, decay: 0.40, detune: 6 },
        { freq: 3520, peak: 0.12, decay: 0.32, detune: -4 },
      ];

      // Sharp initial strike impact (2600Hz, Q=4.5)
      this.noise(ctx, t, {
        peak: 0.24,
        attack: 0.003,
        decay: 0.05,
        filter: { type: "bandpass", q: 4.5, sweep: [[2600, 0]] },
      });

      // Anvil ring partials
      partials.forEach((p, i) => {
        const pan = -0.3 + i * 0.2;
        this.tone(ctx, t, { freq: p.freq, peak: p.peak, attack: 0.004, decay: p.decay, pan });
        this.tone(ctx, t, { freq: p.freq, type: "triangle", peak: p.peak * 0.22, attack: 0.004, decay: p.decay * 0.65, pan, detune: 4 });
      });

      // Octave shimmer
      shimmer.forEach((s) => {
        this.tone(ctx, t, { freq: s.freq, peak: s.peak, attack: 0.004, decay: s.decay, detune: s.detune });
      });

      // High-passed pink-noise hot steam / spark quench sizzle (0.25s, highpass 2400Hz -> 5200Hz sweep)
      this.noise(ctx, t, {
        at: 0.04,
        peak: 0.18,
        attack: 0.008,
        decay: 0.25,
        pan: 0.1,
        filter: { type: "highpass", q: 1.2, sweep: [[2400, 0], [5200, 0.25]] },
      });
    });
  };

  playRiskGateAlert = () => {
    this.play("gate", 600, (ctx, t) => {
      for (const at of [0, 0.28]) {
        const filter: FilterSpec = { type: "lowpass", q: 7, sweep: [[400, 0], [1600, 0.09], [500, 0.24]] };
        this.tone(ctx, t, { freq: 293.66, at, type: "triangle", peak: 0.42, attack: 0.012, decay: 0.24, pan: -0.25, filter });
        this.tone(ctx, t, { freq: 440.0, at, type: "triangle", peak: 0.42, attack: 0.012, decay: 0.24, pan: 0.25, filter });
        this.tone(ctx, t, { freq: 146.83, at, peak: 0.28, attack: 0.012, decay: 0.22 });
      }
    });
  };

  playIncomingCall = () => {
    this.play("call", 1200, (ctx, t) => {
      const motif: FreqPoint[] = [
        [659.25, 0],
        [987.77, 0.16],
        [659.25, 0.62],
        [987.77, 0.78],
      ];
      motif.forEach(([f, at], i) => {
        const pan = -0.8 + (1.6 * i) / (motif.length - 1);
        this.tone(ctx, t, { freq: f, at, peak: 0.34, attack: 0.006, decay: 0.42, pan });
        this.tone(ctx, t, { freq: f * 2.76, at, peak: 0.05, attack: 0.006, decay: 0.18, pan });
        this.tone(ctx, t, { freq: f / 2, at, type: "triangle", peak: 0.06, attack: 0.01, decay: 0.3, pan });
      });
    });
  };

  playCommitSuccess = () => {
    this.play("commit", 500, (ctx, t) => {
      this.tone(ctx, t, { freq: 130.81, peak: 0.25, swell: { level: 0.7, time: 0.08 }, attack: 0.012, decay: 0.45 });
      this.tone(ctx, t, { freq: 65.41, peak: 0.1, swell: { level: 0.28, time: 0.1 }, attack: 0.012, decay: 0.4 });
      [523.25, 659.25, 783.99, 987.77].forEach((f, i) => {
        const at = 0.03 + i * 0.018;
        const pan = -0.45 + i * 0.3;
        this.tone(ctx, t, { freq: f, at, peak: 0.12, attack: 0.012, decay: 0.42, pan, detune: i % 2 ? 5 : -5 });
        this.tone(ctx, t, { freq: f, at, type: "triangle", peak: 0.04, attack: 0.012, decay: 0.4, pan, detune: i % 2 ? -7 : 7 });
      });
    });
  };

  playRewindSweep = (stepsCount = 1) => {
    this.play("rewind", 300, (ctx, t) => {
      const span = 0.42 * Math.min(1.5, 1 + (Math.max(1, stepsCount) - 1) * 0.1);
      const notes = [1046.5, 783.99, 659.25, 523.25, 392.0];
      const glide = notes.slice(1).map((hz, i): FreqPoint => [hz, (span * (i + 1)) / (notes.length - 1)]);
      this.tone(ctx, t, { freq: notes[0], glide, type: "triangle", peak: 0.3, attack: 0.01, decay: span + 0.12, pan: 0.3 });
      this.tone(ctx, t, {
        freq: notes[0] * 2,
        glide: glide.map(([hz, time]): FreqPoint => [hz * 2, time]),
        peak: 0.05,
        attack: 0.01,
        decay: span,
        pan: -0.3,
      });
      this.noise(ctx, t, {
        peak: 0.08,
        attack: 0.012,
        decay: span + 0.05,
        filter: { type: "bandpass", q: 1.4, sweep: [[2800, 0], [220, span]] },
      });
    });
  };

  playUiClick = () => {
    this.play("click", 35, (ctx, t) => {
      this.tone(ctx, t, { freq: 600, peak: 0.3, attack: 0.004, decay: 0.03 });
      this.tone(ctx, t, { freq: 1200, peak: 0.05, attack: 0.004, decay: 0.015 });
    });
  };

  attachVoiceAnalyser = (el: HTMLMediaElement): AnalyserNode | null => {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return null;
    try {
      const src = ctx.createMediaElementSource(el);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.72;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      return analyser;
    } catch {
      return null;
    }
  };

  isEnabled = () => this.enabled;
  getPulse = () => this.pulse;

  setEnabled = (on: boolean) => {
    this.enabled = on;
    try {
      localStorage.setItem(STORAGE_KEY, String(on));
    } catch {
      // storage unavailable — keep in-memory preference
    }
    this.emit();
    if (on) this.playUiClick();
  };

  toggle = () => this.setEnabled(!this.enabled);

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private emit() {
    this.listeners.forEach((fn) => fn());
  }
}

const engine = new SoundEngine();

if (typeof window !== "undefined") {
  for (const type of ["pointerdown", "keydown", "touchend"] as const) {
    window.addEventListener(type, engine.unlock, { capture: true, passive: true });
  }
}

export const soundFx = {
  playStageTick: engine.playStageTick,
  playKeyTick: engine.playKeyTick,
  playWindowPop: engine.playWindowPop,
  playWindowDock: engine.playWindowDock,
  playForgeStart: engine.playForgeStart,
  playForgePass: engine.playForgePass,
  playRiskGateAlert: engine.playRiskGateAlert,
  playIncomingCall: engine.playIncomingCall,
  playCommitSuccess: engine.playCommitSuccess,
  playRewindSweep: engine.playRewindSweep,
  playUiClick: engine.playUiClick,
  attachVoiceAnalyser: engine.attachVoiceAnalyser,
  isEnabled: engine.isEnabled,
  setEnabled: engine.setEnabled,
  toggle: engine.toggle,
  subscribe: engine.subscribe,
  getPulse: engine.getPulse,
};

export function useSfx() {
  const enabled = useSyncExternalStore(engine.subscribe, engine.isEnabled);
  const pulse = useSyncExternalStore(engine.subscribe, engine.getPulse);
  return { enabled, pulse, toggle: engine.toggle };
}
