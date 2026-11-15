import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { soundFx } from "./sound";

/* ------------------------------------------------------------------------
   Voice signal: what the frequency radar (VoiceOrb) visualises.
   `analyser` is set for real cloud audio (Grok Realtime Voice / fal.ai) or
   real microphone input; otherwise the radar synthesises a spectrum from speech cadence.
   ------------------------------------------------------------------------ */

export type VoiceProvider = "fal" | "browser" | "mic" | null;

export interface VoiceSignal {
  mode: "idle" | "speaking" | "listening";
  provider: VoiceProvider;
  analyser: AnalyserNode | null;
}

const IDLE_SIGNAL: VoiceSignal = { mode: "idle", provider: null, analyser: null };
let signal: VoiceSignal = IDLE_SIGNAL;
let lastPulseAt = 0;
const signalListeners = new Set<() => void>();

function setSignal(next: VoiceSignal) {
  signal = next;
  signalListeners.forEach((fn) => fn());
}

function endSignal(mode: VoiceSignal["mode"]) {
  if (signal.mode === mode) setSignal(IDLE_SIGNAL);
}

function pulseVoice() {
  lastPulseAt = performance.now();
}

export const voiceSignal = {
  get: () => signal,
  set: (next: VoiceSignal) => setSignal(next),
  lastPulseAt: () => lastPulseAt,
  subscribe: (fn: () => void) => {
    signalListeners.add(fn);
    return () => {
      signalListeners.delete(fn);
    };
  },
};

export function useVoiceSignal() {
  return useSyncExternalStore(voiceSignal.subscribe, voiceSignal.get);
}

export function getVoiceProviderLabel(provider: VoiceProvider): string {
  if (provider === "fal") return "Grok Realtime Voice";
  if (provider === "mic") return "Live Microphone";
  if (provider === "browser") return "Browser Speech";
  return "Recoup Voice Engine";
}

/* ------------------------------------------------------------------------
   Audio Session Unlocker for iOS Safari & Mobile Chrome
   Tapping "Accept Call" or "Arm Audio" unlocks AudioContext, primes a silent
   audio buffer, and unlocks Web Speech Synthesis in a single user gesture.
   ------------------------------------------------------------------------ */

let sharedAudioContext: AudioContext | null = null;
let sharedMediaElement: HTMLAudioElement | null = null;
let activeSourceNode: AudioBufferSourceNode | null = null;
let warmMicStream: MediaStream | null = null;
let activeWarmMicStream: MediaStream | null = null;
let mobileCallOwnsAudio = false;

export function setMobileCallOwnsAudio(active: boolean): void {
  mobileCallOwnsAudio = active;
}

export function isMobileCallManagingAudio(): boolean {
  return mobileCallOwnsAudio;
}

export function setActiveWarmMicStream(stream: MediaStream | null) {
  activeWarmMicStream = stream;
  if (stream) warmMicStream = stream;
}

export function getActiveWarmMicStream(): MediaStream | null {
  return activeWarmMicStream || warmMicStream;
}

export function getPrimedAudioElement(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (!sharedMediaElement) {
    try {
      const el = new Audio();
      el.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
      el.volume = 0.01;
      el.loop = false;
      el.setAttribute("playsinline", "true");
      (el as unknown as { "webkit-playsinline"?: string })["webkit-playsinline"] = "true";
      sharedMediaElement = el;
    } catch {
      // ignore
    }
  }
  if (sharedMediaElement) {
    sharedMediaElement.loop = false;
  }
  return sharedMediaElement;
}

export function unlockAudioSession(mode: "playback" | "play-and-record" = "playback"): AudioContext | null {
  if (typeof window === "undefined") return null;

  // 1. Configure iOS 17/18 audioSession type
  // CRITICAL: On iOS Safari, "playback" zeroes out all microphone audio (rms === 0)!
  // If warm mic stream is active OR if mobile call owns audio OR if navigator.audioSession.type is ALREADY "play-and-record",
  // NEVER overwrite "play-and-record" back to "playback".
  try {
    const nav = navigator as unknown as { audioSession?: { type: string } };
    if (nav?.audioSession) {
      const isMicActive = Boolean(
        warmMicStream &&
        warmMicStream.active &&
        warmMicStream.getAudioTracks().some((t) => t.readyState === "live")
      );

      if (mode === "play-and-record" || mobileCallOwnsAudio || isMicActive || nav.audioSession.type === "play-and-record") {
        nav.audioSession.type = "play-and-record";
      } else {
        nav.audioSession.type = "playback";
      }
    }
  } catch {
    // Ignore audioSession configuration error
  }

  // 2. Web Audio Context
  try {
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const AudioCtor = w.AudioContext || w.webkitAudioContext;
    if (AudioCtor) {
      if (!sharedAudioContext || sharedAudioContext.state === "closed") {
        sharedAudioContext = new AudioCtor({ latencyHint: "interactive" });
      }
      if (sharedAudioContext.state === "suspended") {
        sharedAudioContext.resume().catch(() => {});
      }
    }
  } catch {
    // Ignore audio context errors
  }

  // 3. Prime silent <audio> element ONCE to unlock iOS media playback without ever pausing active speech
  try {
    const el = getPrimedAudioElement();
    if (el && !mediaElementPrimed && currentAudio !== el && (el.paused || el.ended)) {
      el.loop = false;
      const p = el.play();
      if (p && typeof p.then === "function") {
        p.then(() => {
          mediaElementPrimed = true;
          if (currentAudio !== el) {
            el.pause();
            el.loop = false;
          }
        }).catch(() => {});
      } else {
        mediaElementPrimed = true;
      }
    }
  } catch {
    // Ignore silent audio prime error
  }

  // 4. Unlock SpeechSynthesis ONLY in playback-only mode (never during iOS play-and-record calls where it steals audio focus)
  if (mode !== "play-and-record" && !mobileCallOwnsAudio) {
    try {
      if (typeof window !== "undefined" && window.speechSynthesis && !window.speechSynthesis.speaking) {
        const u = new SpeechSynthesisUtterance(" ");
        u.volume = 0.01;
        window.speechSynthesis.speak(u);
      }
    } catch {
      // Ignore synth prime error
    }
  }

  return sharedAudioContext;
}

export function getSharedAudioContext(): AudioContext | null {
  if (sharedAudioContext) {
    if (sharedAudioContext.state === "suspended") {
      sharedAudioContext.resume().catch(() => {});
    }
    return sharedAudioContext;
  }
  return unlockAudioSession();
}

let mediaElementPrimed = false;
let pendingMicPromise: Promise<MediaStream | null> | null = null;

export async function acquirePersistentMicStream(): Promise<MediaStream | null> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;

  if (
    warmMicStream &&
    warmMicStream.active &&
    warmMicStream.getAudioTracks().some((t) => t.readyState === "live")
  ) {
    warmMicStream.getAudioTracks().forEach((t) => {
      t.enabled = true;
    });
    activeWarmMicStream = warmMicStream;
    unlockAudioSession("play-and-record");
    return warmMicStream;
  }

  if (pendingMicPromise) {
    return pendingMicPromise;
  }

  pendingMicPromise = (async () => {
    try {
      unlockAudioSession("play-and-record");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      stream.getAudioTracks().forEach((t) => {
        t.enabled = true;
      });
      warmMicStream = stream;
      activeWarmMicStream = stream;
      unlockAudioSession("play-and-record");
      return stream;
    } catch (err) {
      console.warn("acquirePersistentMicStream permission or hardware error", err);
      return null;
    } finally {
      pendingMicPromise = null;
    }
  })();

  return pendingMicPromise;
}

export function mutePersistentMicStream(force = false): void {
  if (!warmMicStream) return;
  // Never let passive handlers disable the mic while an active mobile call owns audio
  if (mobileCallOwnsAudio && !force) return;
  try {
    warmMicStream.getAudioTracks().forEach((t) => {
      t.enabled = false;
    });
  } catch {
    // ignore
  }
}

export async function getWarmMicStream(): Promise<MediaStream | null> {
  return acquirePersistentMicStream();
}

export function pickRecorderMimeType(): { mimeType: string; ext: string } {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return { mimeType: "", ext: "webm" };
  }
  const candidates: { mimeType: string; ext: string }[] = [
    { mimeType: "audio/mp4", ext: "mp4" },
    { mimeType: "audio/webm;codecs=opus", ext: "webm" },
    { mimeType: "audio/webm", ext: "webm" },
    { mimeType: "audio/ogg;codecs=opus", ext: "ogg" },
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c.mimeType)) return c;
  }
  return { mimeType: "", ext: "mp4" };
}

/* ------------------------------------------------------------------------
   Voice output: Grok Realtime Voice via /api/voice/turn-audio & /api/voice/briefing
   when available, otherwise falls back cleanly to a single calm Web Speech voice.
   ------------------------------------------------------------------------ */

let remoteRetryAfter = 0;
let currentAudio: HTMLAudioElement | null = null;
let chain: Promise<void> = Promise.resolve();
let generation = 0;
let cancelCurrent: (() => void) | null = null;
let lastTurnKey = "";
let lastTurnAt = 0;
let lastTtsAudioStartedAt = 0;

function pickVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  const preferred = [
    "Microsoft Aria Online (Natural)",
    "Microsoft Jenny Online (Natural)",
    "Google US English",
    "Samantha",
    "Microsoft Aria",
    "Ava",
    "Allison",
    "Serena",
  ];
  for (const name of preferred) {
    const v = voices.find((x) => x.name.includes(name));
    if (v) return v;
  }
  return (
    voices.find((v) => v.lang?.startsWith("en") && v.name.includes("Natural")) ??
    voices.find((v) => v.lang?.startsWith("en"))
  );
}

const turnAudioCache = new Map<string, { buffer: ArrayBuffer; contentType: string }>();
const inflightTurnFetches = new Map<string, Promise<{ buffer: ArrayBuffer; contentType: string } | null>>();

async function fetchRemoteTurnAudio(text: string): Promise<{ buffer: ArrayBuffer; contentType: string } | null> {
  const key = text.trim();
  if (!key) return null;

  const cached = turnAudioCache.get(key);
  if (cached) {
    return { buffer: cached.buffer.slice(0), contentType: cached.contentType };
  }

  const existing = inflightTurnFetches.get(key);
  if (existing) {
    const res = await existing;
    return res ? { buffer: res.buffer.slice(0), contentType: res.contentType } : null;
  }

  const req = (async () => {
    try {
      const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(10000) : undefined;
      const res = await fetch("/api/voice/turn-audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speaker: "agent", text: key }),
        ...(signal ? { signal } : {}),
      });
      const rawType = res.headers.get("content-type") ?? "";
      if (!res.ok || res.status === 204 || !rawType.startsWith("audio")) {
        return null;
      }
      const contentType = rawType.split(";")[0].trim() || "audio/mpeg";
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > 0) {
        if (turnAudioCache.size >= 20) {
          const oldest = turnAudioCache.keys().next().value;
          if (oldest) turnAudioCache.delete(oldest);
        }
        turnAudioCache.set(key, { buffer: buffer.slice(0), contentType });
      }
      return { buffer, contentType };
    } catch {
      return null;
    } finally {
      inflightTurnFetches.delete(key);
    }
  })();

  inflightTurnFetches.set(key, req);
  const out = await req;
  return out ? { buffer: out.buffer.slice(0), contentType: out.contentType } : null;
}

export function prefetchTurnAudio(text: string): void {
  const clean = text.trim();
  if (!clean || turnAudioCache.has(clean) || inflightTurnFetches.has(clean)) return;
  void fetchRemoteTurnAudio(clean);
}

let backendUnreachable = false;

async function fetchRemoteBriefing(text: string, kind: string): Promise<{ buffer: ArrayBuffer; contentType: string } | null> {
  if (Date.now() < remoteRetryAfter) return null;
  try {
    const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(10500) : undefined;
    const res = await fetch("/api/voice/briefing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, kind }),
      ...(signal ? { signal } : {}),
    });
    backendUnreachable = false;
    const rawType = res.headers.get("content-type") ?? "";
    if (!res.ok || res.status === 204 || !rawType.startsWith("audio")) {
      return null;
    }
    remoteRetryAfter = 0;
    const contentType = rawType.split(";")[0].trim() || "audio/mpeg";
    const buffer = await res.arrayBuffer();
    return { buffer, contentType };
  } catch (err) {
    const isTimeout = err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
    if (!isTimeout) {
      backendUnreachable = true;
      remoteRetryAfter = Date.now() + 2500;
    }
    return null;
  }
}

export interface SpeechHooks {
  onStart: () => void;
  onEnd: () => void;
  onProgress?: (fraction: number) => void;
}

function speakOnce(text: string, kind: string, hooks: SpeechHooks) {
  return new Promise<void>((resolve) => {
    let finished = false;
    const token = generation;
    let localSource: AudioBufferSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let rafId: number | null = null;
    let blobUrlToRevoke: string | null = null;

    const done = () => {
      if (finished) return;
      finished = true;
      if (cancelCurrent === done) cancelCurrent = null;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (localSource) {
        try {
          localSource.stop();
          localSource.disconnect();
        } catch {}
        if (activeSourceNode === localSource) activeSourceNode = null;
        localSource = null;
      }
      if (sharedMediaElement && currentAudio === sharedMediaElement) {
        try {
          sharedMediaElement.loop = false;
          sharedMediaElement.pause();
          sharedMediaElement.currentTime = 0;
        } catch {}
        sharedMediaElement.onplay = sharedMediaElement.ontimeupdate = sharedMediaElement.onended = sharedMediaElement.onerror = null;
        currentAudio = null;
      }
      if (blobUrlToRevoke) {
        URL.revokeObjectURL(blobUrlToRevoke);
        blobUrlToRevoke = null;
      }
      if (analyser) {
        try {
          analyser.disconnect();
        } catch {}
        analyser = null;
      }
      endSignal("speaking");
      hooks.onEnd();
      resolve();
    };

    cancelCurrent = done;

    fetchRemoteBriefing(text, kind).then(async (remote) => {
      if (finished || token !== generation) return done();

      if (remote && remote.buffer.byteLength > 0) {
        const { buffer: buf, contentType } = remote;
        const ctx = getSharedAudioContext();
        if (ctx) {
          if (ctx.state === "suspended") {
            await ctx.resume().catch(() => {});
          }
          if (finished || token !== generation) return done();

          let audioBuf: AudioBuffer | null = null;
          try {
            audioBuf = await ctx.decodeAudioData(buf.slice(0));
          } catch (decodeErr) {
            console.warn("decodeAudioData failed", decodeErr);
          }

          if (audioBuf && !finished && token === generation) {
            try {
              const src = ctx.createBufferSource();
              src.buffer = audioBuf;

              const nodeAnalyser = ctx.createAnalyser();
              nodeAnalyser.fftSize = 64;
              nodeAnalyser.smoothingTimeConstant = 0.72;
              src.connect(nodeAnalyser);
              nodeAnalyser.connect(ctx.destination);
              analyser = nodeAnalyser;

              localSource = src;
              activeSourceNode = src;

              const duration = audioBuf.duration;
              const startCtxTime = ctx.currentTime;

              src.onended = () => {
                done();
              };

              setSignal({ mode: "speaking", provider: "fal", analyser: nodeAnalyser });
              hooks.onStart();

              const updateProgress = () => {
                if (finished || token !== generation) return;
                const elapsed = ctx.currentTime - startCtxTime;
                if (duration > 0) {
                  hooks.onProgress?.(Math.min(1, elapsed / duration));
                }
                if (elapsed < duration) {
                  rafId = requestAnimationFrame(updateProgress);
                }
              };
              rafId = requestAnimationFrame(updateProgress);

              src.start(0);
              return;
            } catch (playErr) {
              if (finished || token !== generation) {
                done();
                return;
              }
              console.warn("AudioBufferSourceNode play failed", playErr);
            }
          }
        }

        // Fallback: reuse sharedMediaElement with correct MIME type
        if (!finished && token === generation) {
          try {
            const blob = new Blob([buf], { type: contentType });
            const blobUrl = URL.createObjectURL(blob);
            blobUrlToRevoke = blobUrl;
            const el = getPrimedAudioElement() || new Audio();
            el.loop = false;
            currentAudio = el;
            el.src = blobUrl;
            analyser = soundFx.attachVoiceAnalyser(el);
            let safetyTimer: number | null = null;
            const clearSafety = () => {
              if (safetyTimer !== null) {
                window.clearTimeout(safetyTimer);
                safetyTimer = null;
              }
            };
            const tightenSafety = () => {
              if (Number.isFinite(el.duration) && el.duration > 0) {
                clearSafety();
                const remainingMs = Math.max(350, (el.duration - el.currentTime) * 1000 + 280);
                safetyTimer = window.setTimeout(() => {
                  clearSafety();
                  done();
                }, remainingMs);
              }
            };
            el.onloadedmetadata = () => {
              tightenSafety();
            };
            el.onplay = () => {
              setSignal({ mode: "speaking", provider: "fal", analyser });
              hooks.onStart();
            };
            el.ontimeupdate = () => {
              if (Number.isFinite(el.duration) && el.duration > 0) {
                hooks.onProgress?.(el.currentTime / el.duration);
                tightenSafety();
              }
              if (
                (el.currentTime > 0.25 && el.paused && !el.seeking) ||
                (el.duration > 0 && el.currentTime >= el.duration - 0.04)
              ) {
                clearSafety();
                done();
              }
            };
            el.onended = () => {
              clearSafety();
              done();
            };
            el.onerror = () => {
              clearSafety();
              done();
            };
            await el.play();
            return;
          } catch (elErr) {
            if (finished || token !== generation) {
              done();
              return;
            }
            console.warn("sharedMediaElement fallback play failed", elErr);
          }
        }
      }

      // Fallback: Web Speech Synthesis ONLY when backend is actually unreachable (offline mode).
      // Never mix a robotic browser male voice mid-run when Cloud Grok Voice is active!
      if (finished || token !== generation || !backendUnreachable) return done();
      const synth = window.speechSynthesis;
      if (!synth) return done();
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice();
      if (v) u.voice = v;
      u.rate = 1.04;
      u.pitch = 1.0;
      u.onstart = () => {
        setSignal({ mode: "speaking", provider: "browser", analyser: null });
        pulseVoice();
        hooks.onStart();
      };
      u.onboundary = (e) => {
        pulseVoice();
        hooks.onProgress?.(Math.min(1, (e.charIndex + (e.charLength ?? 0)) / text.length));
      };
      u.onend = done;
      u.onerror = done;
      synth.speak(u);
      window.setTimeout(done, Math.max(4000, text.length * 90));
    });
  });
}

export function speakBriefing(text: string, kind: string, hooks: SpeechHooks, interrupt = false) {
  if (interrupt) stopSpeaking();
  const gen = generation;
  let settled = false;
  const guardedEnd = () => {
    if (settled) return;
    settled = true;
    hooks.onEnd();
  };
  chain = (interrupt ? Promise.resolve() : chain).then(() => {
    if (gen !== generation) return guardedEnd();
    return speakOnce(text, kind, { onStart: hooks.onStart, onEnd: guardedEnd, onProgress: hooks.onProgress });
  });
}

function speakTurnOnce(text: string, hooks?: Partial<SpeechHooks>) {
  return new Promise<void>((resolve) => {
    let finished = false;
    const token = generation;
    let localSource: AudioBufferSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let rafId: number | null = null;
    let progressTimer: number | null = null;
    let blobUrlToRevoke: string | null = null;
    let safetyTimer: number | null = null;
    let startedFired = false;

    const clearTimers = () => {
      if (safetyTimer !== null) {
        window.clearTimeout(safetyTimer);
        safetyTimer = null;
      }
      if (progressTimer !== null) {
        window.clearInterval(progressTimer);
        progressTimer = null;
      }
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    const fireStart = () => {
      if (startedFired || finished || token !== generation) return;
      startedFired = true;
      lastTtsAudioStartedAt = performance.now();
      pulseVoice();
      hooks?.onStart?.();
    };

    const done = () => {
      if (finished) return;
      finished = true;
      clearTimers();
      if (cancelCurrent === done) cancelCurrent = null;
      if (localSource) {
        try {
          localSource.stop();
          localSource.disconnect();
        } catch {}
        if (activeSourceNode === localSource) activeSourceNode = null;
        localSource = null;
      }
      if (sharedMediaElement && currentAudio === sharedMediaElement) {
        try {
          sharedMediaElement.loop = false;
          sharedMediaElement.pause();
          sharedMediaElement.currentTime = 0;
        } catch {}
        sharedMediaElement.onplay = sharedMediaElement.onplaying = sharedMediaElement.ontimeupdate = sharedMediaElement.onended = sharedMediaElement.onerror = sharedMediaElement.onloadedmetadata = null;
        currentAudio = null;
      }
      if (blobUrlToRevoke) {
        URL.revokeObjectURL(blobUrlToRevoke);
        blobUrlToRevoke = null;
      }
      if (analyser) {
        try {
          analyser.disconnect();
        } catch {}
        analyser = null;
      }
      endSignal("speaking");
      sharedAudioContext?.resume().catch(() => undefined);
      if (mobileCallOwnsAudio && warmMicStream) {
        try {
          warmMicStream.getAudioTracks().forEach((track) => {
            track.enabled = true;
          });
        } catch {}
      }
      hooks?.onEnd?.();
      resolve();
    };

    cancelCurrent = done;

    // Keep play-and-record steady throughout active call on iOS Safari
    if (mobileCallOwnsAudio || (warmMicStream && warmMicStream.active)) {
      unlockAudioSession("play-and-record");
    }

    fetchRemoteTurnAudio(text).then(async (remote) => {
      if (finished || token !== generation) return done();

      const words = text.trim().split(/\s+/).filter(Boolean);
      const estDurationSec = Math.max(1.2, words.length / 2.8);

      if (remote && remote.buffer.byteLength > 0) {
        const { buffer: buf, contentType } = remote;

        // Primary path: unlocked sharedMediaElement with proper MIME Blob.
        // On iOS / mobile calls, HTMLAudioElement with playsInline routes reliably through
        // iOS's PlayAndRecord session without AudioContext sample-rate lockups after MediaRecorder stops.
        let mediaElementPlayed = false;
        try {
          const blob = new Blob([buf], { type: contentType });
          const blobUrl = URL.createObjectURL(blob);
          blobUrlToRevoke = blobUrl;
          const el = getPrimedAudioElement() || new Audio();
          el.setAttribute("playsinline", "true");
          (el as unknown as { "webkit-playsinline"?: string })["webkit-playsinline"] = "true";
          el.volume = 1.0;
          el.loop = false;
          currentAudio = el;
          el.src = blobUrl;

          let playStartTime = 0;

          const startMediaProgress = () => {
            if (finished || token !== generation) return;
            fireStart();
            setSignal({ mode: "speaking", provider: "fal", analyser: null });
            if (playStartTime === 0) playStartTime = performance.now();

            if (progressTimer !== null) {
              window.clearInterval(progressTimer);
            }
            progressTimer = window.setInterval(() => {
              if (finished || token !== generation) {
                if (progressTimer !== null) {
                  window.clearInterval(progressTimer);
                  progressTimer = null;
                }
                return;
              }
              let p = 0;
              if (Number.isFinite(el.duration) && el.duration > 0) {
                p = Math.min(1, Math.max(0, el.currentTime / el.duration));
              } else {
                const elapsedSec = (performance.now() - playStartTime) / 1000;
                p = Math.min(1, Math.max(0, elapsedSec / estDurationSec));
              }
              hooks?.onProgress?.(p);
            }, 60);
          };

          const tightenSafetyTimer = () => {
            if (Number.isFinite(el.duration) && el.duration > 0) {
              if (safetyTimer !== null) {
                window.clearTimeout(safetyTimer);
                safetyTimer = null;
              }
              const minExpectedMs = Math.max(1800, words.length * 260);
              const remainingMs = Math.max(minExpectedMs, (el.duration - el.currentTime) * 1000 + 650);
              safetyTimer = window.setTimeout(() => {
                done();
              }, remainingMs);
            }
          };

          el.onloadedmetadata = () => {
            tightenSafetyTimer();
          };

          el.onplay = () => {
            startMediaProgress();
          };
          el.onplaying = () => {
            startMediaProgress();
          };
          el.ontimeupdate = () => {
            pulseVoice();
            if (Number.isFinite(el.duration) && el.duration > 0) {
              hooks?.onProgress?.(Math.min(1, Math.max(0, el.currentTime / el.duration)));
              tightenSafetyTimer();
            }
            if (el.ended) {
              done();
            }
          };
          el.onended = () => {
            done();
          };
          el.onerror = () => {
            done();
          };

          safetyTimer = window.setTimeout(() => {
            done();
          }, Math.max(4000, text.length * 95));

          await el.play();
          startMediaProgress();
          mediaElementPlayed = true;
          return;
        } catch (elErr) {
          if (finished || token !== generation) {
            done();
            return;
          }
          console.warn("sharedMediaElement playback failed, falling back to WebAudio decode", elErr);
          clearTimers();
          if (blobUrlToRevoke) {
            URL.revokeObjectURL(blobUrlToRevoke);
            blobUrlToRevoke = null;
          }
          currentAudio = null;
        }

        // Secondary path: Web Audio Context decodeAudioData if media element rejected
        if (!finished && token === generation && !mediaElementPlayed) {
          const ctx = getSharedAudioContext();
          if (ctx) {
            if (ctx.state === "suspended") {
              await ctx.resume().catch(() => {});
            }
            if (finished || token !== generation) return done();

            let audioBuf: AudioBuffer | null = null;
            try {
              audioBuf = await ctx.decodeAudioData(buf.slice(0));
            } catch (decodeErr) {
              console.warn("decodeAudioData failed", decodeErr);
            }

            if (audioBuf && !finished && token === generation) {
              try {
                const src = ctx.createBufferSource();
                src.buffer = audioBuf;

                const nodeAnalyser = ctx.createAnalyser();
                nodeAnalyser.fftSize = 64;
                nodeAnalyser.smoothingTimeConstant = 0.72;
                src.connect(nodeAnalyser);
                nodeAnalyser.connect(ctx.destination);
                analyser = nodeAnalyser;

                localSource = src;
                activeSourceNode = src;

                const duration = audioBuf.duration;
                const startCtxTime = ctx.currentTime;

                src.onended = () => {
                  done();
                };

                safetyTimer = window.setTimeout(() => {
                  done();
                }, Math.max(4000, Math.round(duration * 1000) + 1200));

                setSignal({ mode: "speaking", provider: "fal", analyser: nodeAnalyser });
                fireStart();

                const updateProgress = () => {
                  if (finished || token !== generation) return;
                  const elapsed = ctx.currentTime - startCtxTime;
                  if (duration > 0) {
                    hooks?.onProgress?.(Math.min(1, Math.max(0, elapsed / duration)));
                  }
                  if (elapsed < duration) {
                    rafId = requestAnimationFrame(updateProgress);
                  }
                };
                rafId = requestAnimationFrame(updateProgress);

                src.start(0);
                return;
              } catch (playErr) {
                if (finished || token !== generation) {
                  done();
                  return;
                }
                console.warn("AudioBufferSourceNode play failed", playErr);
                clearTimers();
              }
            }
          }
        }
      }

      // Tertiary fallback: Web Speech Synthesis
      if (finished || token !== generation) return done();
      const synth = window.speechSynthesis;
      if (!synth) return done();
      const u = new SpeechSynthesisUtterance(text);
      const calmVoice = pickVoice();
      if (calmVoice) u.voice = calmVoice;
      u.rate = 1.04;
      u.pitch = 1.0;

      const estimatedDurationMs = Math.max(1200, words.length * 340);
      let synthStartTime = 0;

      u.onstart = () => {
        synthStartTime = performance.now();
        setSignal({ mode: "speaking", provider: "browser", analyser: null });
        fireStart();

        if (progressTimer !== null) {
          window.clearInterval(progressTimer);
        }
        progressTimer = window.setInterval(() => {
          if (finished || token !== generation) {
            if (progressTimer !== null) {
              window.clearInterval(progressTimer);
              progressTimer = null;
            }
            return;
          }
          const elapsed = performance.now() - synthStartTime;
          const p = Math.min(1, elapsed / estimatedDurationMs);
          hooks?.onProgress?.(p);
          if (p >= 1 && progressTimer !== null) {
            window.clearInterval(progressTimer);
            progressTimer = null;
          }
        }, 60);
      };
      u.onboundary = (e) => {
        pulseVoice();
        const boundaryProgress = Math.min(1, (e.charIndex + (e.charLength ?? 0)) / text.length);
        hooks?.onProgress?.(boundaryProgress);
      };
      u.onend = () => {
        done();
      };
      u.onerror = () => {
        done();
      };
      synth.speak(u);
      safetyTimer = window.setTimeout(done, Math.max(3800, text.length * 85));
    });
  });
}

export function speakCallTurn(
  speaker: "agent" | "counterparty" | "user",
  text: string,
  hooks?: Partial<SpeechHooks>,
  interrupt?: boolean
): void;
export function speakCallTurn(
  text: string,
  hooks?: Partial<SpeechHooks>,
  interrupt?: boolean
): void;
export function speakCallTurn(
  arg1: "agent" | "counterparty" | "user" | string,
  arg2?: string | Partial<SpeechHooks>,
  arg3?: Partial<SpeechHooks> | boolean,
  arg4?: boolean
) {
  let speaker: "agent" | "counterparty" | "user" = "agent";
  let text = "";
  let hooks: Partial<SpeechHooks> | undefined;
  let interrupt = false;

  if (arg1 === "agent" || arg1 === "counterparty" || arg1 === "user") {
    speaker = arg1;
    text = typeof arg2 === "string" ? arg2 : "";
    hooks = typeof arg3 === "object" && arg3 !== null ? (arg3 as Partial<SpeechHooks>) : undefined;
    interrupt = typeof arg3 === "boolean" ? arg3 : Boolean(arg4);
  } else {
    speaker = "agent";
    text = arg1;
    hooks = typeof arg2 === "object" && arg2 !== null ? (arg2 as Partial<SpeechHooks>) : undefined;
    interrupt = typeof arg3 === "boolean" ? arg3 : Boolean(arg4);
  }

  const cleanText = text.trim();
  if (!cleanText) {
    hooks?.onEnd?.();
    return;
  }
  // Never synthesize TTS for the human operator's own transcript turn.
  if (speaker === "user") {
    hooks?.onStart?.();
    hooks?.onProgress?.(1);
    hooks?.onEnd?.();
    return;
  }

  const now = Date.now();
  if (!interrupt && cleanText === lastTurnKey && now - lastTurnAt < 1500) {
    // Same line fired twice in quick succession (e.g. a duplicate SSE delivery) - skip
    // re-synthesizing it, but still settle the caller's hooks so UI state (speaking/
    // activeSpeaker flags) never gets stuck waiting for an onEnd that would otherwise
    // never arrive.
    hooks?.onStart?.();
    hooks?.onProgress?.(1);
    hooks?.onEnd?.();
    return;
  }
  lastTurnKey = cleanText;
  lastTurnAt = now;

  if (interrupt) stopSpeaking();
  const gen = generation;
  let settled = false;
  const guardedEnd = () => {
    if (settled) return;
    settled = true;
    hooks?.onEnd?.();
  };
  chain = (interrupt ? Promise.resolve() : chain).then(() => {
    if (gen !== generation) {
      guardedEnd();
      return;
    }
    return speakTurnOnce(cleanText, {
      onStart: hooks?.onStart,
      onEnd: guardedEnd,
      onProgress: hooks?.onProgress,
    });
  });
}

export function stopSpeaking() {
  generation += 1;
  window.speechSynthesis?.cancel();
  if (activeSourceNode) {
    try {
      activeSourceNode.stop();
      activeSourceNode.disconnect();
    } catch {}
    activeSourceNode = null;
  }
  if (sharedMediaElement) {
    try {
      sharedMediaElement.loop = false;
      sharedMediaElement.pause();
      sharedMediaElement.currentTime = 0;
    } catch {}
  }
  if (currentAudio) {
    try {
      currentAudio.loop = false;
      currentAudio.pause();
    } catch {}
    currentAudio = null;
  }
  cancelCurrent?.();
  chain = Promise.resolve();
  endSignal("speaking");
  sharedAudioContext?.resume().catch(() => undefined);
  if (mobileCallOwnsAudio && warmMicStream) {
    try {
      warmMicStream.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });
    } catch {}
  }
}

/* ------------------------------------------------------------------------
   Push-to-talk input via (webkit)SpeechRecognition.
   ------------------------------------------------------------------------ */

interface RecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<RecognitionResultLike>;
}
interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}
type RecognitionCtor = new () => RecognitionLike;

function getRecognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function hasSpeechRecognition(): boolean {
  return typeof window !== "undefined" && getRecognitionCtor() !== null;
}

export function useSpeechInput(onTranscript: (text: string, final: boolean) => void) {
  const [listening, setListening] = useState(false);
  const recRef = useRef<RecognitionLike | null>(null);
  const cbRef = useRef(onTranscript);
  cbRef.current = onTranscript;
  const supported = typeof window !== "undefined" && getRecognitionCtor() !== null;

  const stop = useCallback(() => {
    recRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor || recRef.current) return;
    stopSpeaking();
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      let text = "";
      let final = false;
      for (let i = 0; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
        if (e.results[i].isFinal) final = true;
      }
      pulseVoice();
      cbRef.current(text.trim(), final);
    };
    rec.onend = () => {
      recRef.current = null;
      setListening(false);
      endSignal("listening");
    };
    rec.onerror = () => {
      recRef.current = null;
      setListening(false);
      endSignal("listening");
    };
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
      setSignal({ mode: "listening", provider: "mic", analyser: null });
      pulseVoice();
    } catch {
      recRef.current = null;
      setListening(false);
    }
  }, []);

  useEffect(() => () => recRef.current?.stop(), []);

  return { supported, listening, start, stop, toggle: listening ? stop : start };
}

/* ------------------------------------------------------------------------
   Smart Echo-Safe Auto-VAD (Voice Activity Detector)
   - Operates on a warm, persistent MediaStream (never re-prompts on iOS Safari).
   - Feeds live mic energy to AnalyserNode & VoiceSignal for radial pulsing.
   - Pauses during agent TTS + 280ms cooldown to completely prevent self-echo.
   - Calibrates noise floor over the initial 250ms.
   - Emits completed utterance blob after 850ms silence (or 11s max safety cap)
     with zero button taps required.
   ------------------------------------------------------------------------ */

export type AutoVadPhase = "idle" | "listening" | "hearing" | "syncing";

export interface UseAutoVadOptions {
  stream: MediaStream | null;
  enabled: boolean;
  agentSpeaking: boolean;
  muted: boolean;
  onUtterance: (blob: Blob, mimeType: string, ext: string) => void;
  onPhaseChange?: (phase: AutoVadPhase) => void;
  onRms?: (rms: number) => void;
  onBargeIn?: () => void;
}

export interface UseAutoVadReturn {
  phase: AutoVadPhase;
  setPhase: (phase: AutoVadPhase) => void;
  rms: number;
  sendNow: () => void;
  startManualRecording: () => void;
  stopAndSendManualRecording: () => void;
  manualRecording: boolean;
  analyser: AnalyserNode | null;
}

export function useAutoVad({
  stream,
  enabled,
  agentSpeaking,
  muted,
  onUtterance,
  onPhaseChange,
  onRms,
  onBargeIn,
}: UseAutoVadOptions): UseAutoVadReturn {
  const [phase, setPhaseState] = useState<AutoVadPhase>("idle");
  const [rmsLevel, setRmsLevel] = useState(0);
  const [manualRecording, setManualRecording] = useState(false);

  const phaseRef = useRef<AutoVadPhase>("idle");
  const manualRecordingRef = useRef(false);
  const hasSpokenInManualSessionRef = useRef(false);

  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;
  const onPhaseChangeRef = useRef(onPhaseChange);
  onPhaseChangeRef.current = onPhaseChange;
  const onRmsRef = useRef(onRms);
  onRmsRef.current = onRms;
  const onBargeInRef = useRef(onBargeIn);
  onBargeInRef.current = onBargeIn;

  const agentSpeakingRef = useRef(agentSpeaking);
  agentSpeakingRef.current = agentSpeaking;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const recorderRef = useRef<MediaRecorder | null>(null);
  const speechStartAtRef = useRef<number>(0);
  const lastActiveSpeechAtRef = useRef<number>(0);
  const agentStoppedAtRef = useRef<number>(0);
  const agentSpeechStartedAtRef = useRef<number>(0);
  const ttsStartGraceUntilRef = useRef<number>(0);
  const consecutiveSpeechFramesRef = useRef<number>(0);
  const consecutiveBargeInFramesRef = useRef<number>(0);
  const lastContextResumeAttemptAtRef = useRef<number>(0);
  const noiseFloorRef = useRef<number>(0.015);
  const calibrationFramesRef = useRef<number>(0);
  const peakSpeechRmsRef = useRef<number>(0);
  const syncingSinceRef = useRef<number>(0);
  const cancelActiveRecordingRef = useRef<(() => void) | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  const setPhase = useCallback((next: AutoVadPhase) => {
    phaseRef.current = next;
    if (next === "syncing") {
      syncingSinceRef.current = performance.now();
    } else {
      syncingSinceRef.current = 0;
    }
    setPhaseState(next);
    onPhaseChangeRef.current?.(next);
  }, []);

  // Track when agent finishes speaking for the 220ms post-TTS cooldown, and track when agent starts speaking
  useEffect(() => {
    if (!agentSpeaking) {
      agentStoppedAtRef.current = performance.now();
      consecutiveBargeInFramesRef.current = 0;
    } else {
      agentSpeechStartedAtRef.current = performance.now();
      ttsStartGraceUntilRef.current = performance.now() + 700;
      consecutiveBargeInFramesRef.current = 0;
      // Recoup began speaking: if we were hearing or manually recording, abort recording to avoid echo
      manualRecordingRef.current = false;
      setManualRecording(false);
      hasSpokenInManualSessionRef.current = false;
      if (phaseRef.current === "hearing") {
        cancelActiveRecordingRef.current?.();
        setPhase("listening");
      }
    }
  }, [agentSpeaking, setPhase]);

  // Center orb tap shortcut: stop recording and send utterance immediately
  const stopAndSendManualRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state === "recording") {
      pulseVoice();
      manualRecordingRef.current = true;
      setPhase("syncing");
      try {
        recorderRef.current.stop();
      } catch {
        setPhase("listening");
      }
    } else {
      setPhase("listening");
    }
  }, [setPhase]);

  const sendNow = stopAndSendManualRecording;

  // Manual tap-to-speak: starts recording immediately regardless of RMS threshold
  const startManualRecording = useCallback(() => {
    if (!enabled || !stream) return;
    unlockAudioSession("play-and-record");

    cancelActiveRecordingRef.current?.();

    manualRecordingRef.current = true;
    hasSpokenInManualSessionRef.current = false;
    setManualRecording(true);
    consecutiveSpeechFramesRef.current = 0;
    peakSpeechRmsRef.current = 0;

    const { mimeType, ext } = pickRecorderMimeType();
    const localChunks: BlobPart[] = [];
    let discarded = false;
    const now = performance.now();
    speechStartAtRef.current = now;
    lastActiveSpeechAtRef.current = now;

    try {
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      cancelActiveRecordingRef.current = () => {
        discarded = true;
        if (rec.state !== "inactive") {
          try {
            rec.stop();
          } catch {
            // ignore
          }
        }
      };
      rec.ondataavailable = (ev) => {
        if (!discarded && ev.data && ev.data.size > 0) {
          localChunks.push(ev.data);
        }
      };
      rec.onstop = () => {
        const wasManual = manualRecordingRef.current;
        manualRecordingRef.current = false;
        setManualRecording(false);
        hasSpokenInManualSessionRef.current = false;

        if (discarded) {
          return;
        }
        const blob = new Blob(localChunks, { type: rec.mimeType || mimeType || "audio/mp4" });
        const totalSpeechDuration = lastActiveSpeechAtRef.current - speechStartAtRef.current;

        // Either manual tap-to-speak or valid speech duration & size
        if (wasManual || (blob.size >= 600 && totalSpeechDuration >= 200)) {
          onUtteranceRef.current(blob, rec.mimeType || mimeType, ext);
        } else {
          setPhase("listening");
        }
      };
      recorderRef.current = rec;
      rec.start(200);
      setPhase("hearing");
      pulseVoice();
    } catch (recErr) {
      console.warn("Auto-VAD: MediaRecorder manual start failed", recErr);
      manualRecordingRef.current = false;
      setManualRecording(false);
      setPhase("listening");
    }
  }, [enabled, setPhase, stream]);

  useEffect(() => {
    if (!enabled || !stream) {
      setPhase("idle");
      setRmsLevel(0);
      manualRecordingRef.current = false;
      setManualRecording(false);
      hasSpokenInManualSessionRef.current = false;
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        try {
          recorderRef.current.stop();
        } catch {
          // ignore
        }
      }
      return;
    }

    stream.getAudioTracks().forEach((t) => {
      t.enabled = true;
    });
    warmMicStream = stream;
    activeWarmMicStream = stream;
    // Always configure iOS audioSession to "play-and-record" when mic stream is armed
    const ctx = unlockAudioSession("play-and-record");
    if (!ctx) return;

    let sourceNode: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;

    try {
      sourceNode = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.42;
      sourceNode.connect(analyser);
      analyserRef.current = analyser;
    } catch (err) {
      console.warn("Auto-VAD: Could not connect stream to AudioContext analyser", err);
      return;
    }

    setPhase("listening");
    const dataBuffer = new Float32Array(analyser.fftSize);
    const freqBins = new Uint8Array(analyser.frequencyBinCount);
    let rafId: number | null = null;
    let running = true;

    const startRecordingUtterance = (now: number, initialRms = 0) => {
      cancelActiveRecordingRef.current?.();

      const { mimeType, ext } = pickRecorderMimeType();
      const localChunks: BlobPart[] = [];
      let discarded = false;
      speechStartAtRef.current = now;
      lastActiveSpeechAtRef.current = now;
      peakSpeechRmsRef.current = initialRms;
      manualRecordingRef.current = false;
      hasSpokenInManualSessionRef.current = true;

      try {
        const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        cancelActiveRecordingRef.current = () => {
          discarded = true;
          if (rec.state !== "inactive") {
            try {
              rec.stop();
            } catch {
              // ignore
            }
          }
        };
        rec.ondataavailable = (ev) => {
          if (!discarded && ev.data && ev.data.size > 0) {
            localChunks.push(ev.data);
          }
        };
        rec.onstop = () => {
          const wasManual = manualRecordingRef.current;
          manualRecordingRef.current = false;
          setManualRecording(false);
          hasSpokenInManualSessionRef.current = false;

          if (discarded) {
            return;
          }
          const blob = new Blob(localChunks, { type: rec.mimeType || mimeType || "audio/mp4" });
          const totalSpeechDuration = lastActiveSpeechAtRef.current - speechStartAtRef.current;
          if (wasManual || (blob.size >= 600 && totalSpeechDuration >= 200)) {
            onUtteranceRef.current(blob, rec.mimeType || mimeType, ext);
          } else {
            setPhase("listening");
          }
        };
        recorderRef.current = rec;
        rec.start(200);
        setPhase("hearing");
        pulseVoice();
      } catch (recErr) {
        console.warn("Auto-VAD: MediaRecorder start failed", recErr);
        setPhase("listening");
      }
    };

    const vadLoop = () => {
      if (!running) return;

      const now = performance.now();
      const isAgentSpeaking = agentSpeakingRef.current;
      const isMuted = mutedRef.current;

      // AudioContext state resume guard (throttled to at most once every 500ms)
      if (ctx.state !== "running" && now - lastContextResumeAttemptAtRef.current > 500) {
        lastContextResumeAttemptAtRef.current = now;
        ctx.resume().catch(() => undefined);
      }

      if (isMuted) {
        consecutiveSpeechFramesRef.current = 0;
        consecutiveBargeInFramesRef.current = 0;
        rafId = requestAnimationFrame(vadLoop);
        return;
      }

      const currentPhase = phaseRef.current;
      const isPostTtsCooldown = !isAgentSpeaking && currentPhase === "listening" && (now - agentStoppedAtRef.current < 220);
      if (isPostTtsCooldown) {
        consecutiveSpeechFramesRef.current = 0;
        consecutiveBargeInFramesRef.current = 0;
        rafId = requestAnimationFrame(vadLoop);
        return;
      }

      // Compute time-domain RMS
      analyser.getFloatTimeDomainData(dataBuffer);
      let sumSquares = 0;
      for (let i = 0; i < dataBuffer.length; i++) {
        const v = dataBuffer[i];
        sumSquares += v * v;
      }
      const rawRms = Math.sqrt(sumSquares / dataBuffer.length);
      const rms = Number.isFinite(rawRms) ? rawRms : 0;

      setRmsLevel(rms);
      onRmsRef.current?.(rms);

      // Compute Frequency-Domain Human Vocal Band Ratio and peak vocal energy
      analyser.getByteFrequencyData(freqBins);
      const sampleRate = ctx.sampleRate || 48000;
      const binHz = sampleRate / analyser.fftSize;
      let vocalEnergy = 0;
      let totalEnergy = 0;
      let peakBinEnergy = 0;
      for (let i = 0; i < freqBins.length; i++) {
        const freq = i * binHz;
        const val = freqBins[i];
        if (freq >= 80 && freq <= 8000) {
          totalEnergy += val;
          if (freq >= 300 && freq <= 3400) {
            vocalEnergy += val;
            if (val > peakBinEnergy) {
              peakBinEnergy = val;
            }
          }
        }
      }
      const voiceBandRatio = vocalEnergy / (totalEnergy + 1e-6);

      // Dynamic ambient noise floor calibration: fast initial lock + continuous slow tracking in loud venues
      if (!isAgentSpeaking) {
        if (calibrationFramesRef.current < 35) {
          calibrationFramesRef.current++;
          noiseFloorRef.current = noiseFloorRef.current * 0.90 + Math.max(0.005, Math.min(0.075, rms)) * 0.10;
        } else if (currentPhase === "listening" && consecutiveSpeechFramesRef.current === 0) {
          noiseFloorRef.current = noiseFloorRef.current * 0.975 + Math.max(0.006, Math.min(0.085, rms)) * 0.025;
        }
      }
      const noiseFloor = noiseFloorRef.current;

      // When Recoup is speaking: Live Barge-In Gate
      if (isAgentSpeaking) {
        consecutiveSpeechFramesRef.current = 0;
        const graceUntil = Math.max(ttsStartGraceUntilRef.current, lastTtsAudioStartedAt + 700);
        if (now < graceUntil) {
          consecutiveBargeInFramesRef.current = 0;
          rafId = requestAnimationFrame(vadLoop);
          return;
        }

        const isLoudRms = rms > Math.max(0.115, noiseFloorRef.current * 5.8);
        const isVocalRatio = voiceBandRatio > 0.66;
        const isPeakHarmonic = peakBinEnergy > 45;

        if (isLoudRms && isVocalRatio && isPeakHarmonic) {
          consecutiveBargeInFramesRef.current++;
          if (consecutiveBargeInFramesRef.current >= 22) {
            consecutiveBargeInFramesRef.current = 0;
            stopSpeaking();
            onBargeInRef.current?.();
            startRecordingUtterance(now, rms);
          }
        } else {
          consecutiveBargeInFramesRef.current = Math.max(0, consecutiveBargeInFramesRef.current - 2);
        }

        rafId = requestAnimationFrame(vadLoop);
        return;
      }

      // Normal listening: keep VoiceOrb reactive to live microphone energy
      if (signal.mode !== "speaking") {
        setSignal({ mode: "listening", provider: "mic", analyser });
        if (rms > 0.02) pulseVoice();
      }

      if (currentPhase === "listening") {
        const speechStartThreshold = Math.max(0.03, noiseFloor * 2.6);
        if (rms > speechStartThreshold && voiceBandRatio > 0.54) {
          consecutiveSpeechFramesRef.current++;
          if (consecutiveSpeechFramesRef.current >= 7) {
            consecutiveSpeechFramesRef.current = 0;
            startRecordingUtterance(now, rms);
          }
        } else {
          consecutiveSpeechFramesRef.current = Math.max(0, consecutiveSpeechFramesRef.current - 1);
        }
      } else if (currentPhase === "hearing") {
        if (rms > peakSpeechRmsRef.current) {
          peakSpeechRmsRef.current = rms;
        }
        // Require close-mic vocal energy above ambient venue chatter AND >=38% of user's own speech peak
        const speechActiveThreshold = Math.max(0.02, noiseFloor * 1.85, peakSpeechRmsRef.current * 0.38);
        if (rms >= speechActiveThreshold && voiceBandRatio > 0.45) {
          hasSpokenInManualSessionRef.current = true;
          lastActiveSpeechAtRef.current = now;
        }

        const silenceDuration = hasSpokenInManualSessionRef.current
          ? now - lastActiveSpeechAtRef.current
          : manualRecordingRef.current
          ? 0
          : now - speechStartAtRef.current;
        const totalDuration = now - speechStartAtRef.current;

        // Auto-complete turn when 700ms pause occurs after speech OR 6.5s loud-venue cap reached
        if (
          (hasSpokenInManualSessionRef.current && silenceDuration >= 700 && totalDuration >= 280) ||
          totalDuration >= 6500
        ) {
          const rec = recorderRef.current;
          if (rec && rec.state !== "inactive") {
            setPhase("syncing");
            try {
              rec.stop();
            } catch {
              setPhase("listening");
            }
          } else {
            setPhase("listening");
          }
        }
      } else if (currentPhase === "syncing") {
        // Watchdog: if VAD remains enabled in "syncing" without caller disabling it for >1.8s, self-heal to listening
        if (syncingSinceRef.current > 0 && now - syncingSinceRef.current > 1800) {
          setPhase("listening");
        }
      }

      rafId = requestAnimationFrame(vadLoop);
    };

    rafId = requestAnimationFrame(vadLoop);

    return () => {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      manualRecordingRef.current = false;
      setManualRecording(false);
      hasSpokenInManualSessionRef.current = false;
      cancelActiveRecordingRef.current?.();
      analyserRef.current = null;
      try {
        sourceNode?.disconnect();
        analyser?.disconnect();
      } catch {
        // ignore
      }
      endSignal("listening");
    };
  }, [enabled, setPhase, stream]);

  return {
    phase,
    setPhase,
    rms: rmsLevel,
    sendNow,
    startManualRecording,
    stopAndSendManualRecording,
    manualRecording,
    analyser: analyserRef.current,
  };
}
