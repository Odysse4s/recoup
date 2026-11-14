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
      el.setAttribute("playsinline", "true");
      (el as unknown as { "webkit-playsinline"?: string })["webkit-playsinline"] = "true";
      sharedMediaElement = el;
    } catch {
      // ignore
    }
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

  // 3. Prime silent <audio> element to unlock iOS media playback
  try {
    const el = getPrimedAudioElement();
    if (el) {
      el.play().then(() => {
        el.pause();
      }).catch(() => {});
    }
  } catch {
    // Ignore silent audio prime error
  }

  // 4. Unlock SpeechSynthesis
  try {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0.01;
      window.speechSynthesis.speak(u);
    }
  } catch {
    // Ignore synth prime error
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

  try {
    unlockAudioSession("play-and-record");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
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
  }
}

export function mutePersistentMicStream(): void {
  if (!warmMicStream) return;
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

async function fetchRemoteTurnAudio(text: string): Promise<{ buffer: ArrayBuffer; contentType: string } | null> {
  try {
    const res = await fetch("/api/voice/turn-audio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speaker: "agent", text }),
    });
    const rawType = res.headers.get("content-type") ?? "";
    if (!res.ok || res.status === 204 || !rawType.startsWith("audio")) {
      return null;
    }
    const contentType = rawType.split(";")[0].trim() || "audio/mpeg";
    const buffer = await res.arrayBuffer();
    return { buffer, contentType };
  } catch {
    return null;
  }
}

async function fetchRemoteBriefing(text: string, kind: string): Promise<{ buffer: ArrayBuffer; contentType: string } | null> {
  if (Date.now() < remoteRetryAfter) return null;
  try {
    const res = await fetch("/api/voice/briefing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, kind }),
    });
    const rawType = res.headers.get("content-type") ?? "";
    if (!res.ok || res.status === 204 || !rawType.startsWith("audio")) {
      return null;
    }
    remoteRetryAfter = 0;
    const contentType = rawType.split(";")[0].trim() || "audio/mpeg";
    const buffer = await res.arrayBuffer();
    return { buffer, contentType };
  } catch {
    remoteRetryAfter = Date.now() + 5000;
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
      if (finished) return;

      if (remote && remote.buffer.byteLength > 0) {
        const { buffer: buf, contentType } = remote;
        const ctx = getSharedAudioContext();
        if (ctx) {
          if (ctx.state === "suspended") {
            await ctx.resume().catch(() => {});
          }
          if (finished) return;

          let audioBuf: AudioBuffer | null = null;
          try {
            audioBuf = await ctx.decodeAudioData(buf.slice(0));
          } catch (decodeErr) {
            console.warn("decodeAudioData failed", decodeErr);
          }

          if (audioBuf && !finished) {
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
                if (finished) return;
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
              console.warn("AudioBufferSourceNode play failed", playErr);
            }
          }
        }

        // Fallback: reuse sharedMediaElement with correct MIME type
        if (!finished) {
          try {
            const blob = new Blob([buf], { type: contentType });
            const blobUrl = URL.createObjectURL(blob);
            blobUrlToRevoke = blobUrl;
            const el = getPrimedAudioElement() || new Audio();
            currentAudio = el;
            el.src = blobUrl;
            analyser = soundFx.attachVoiceAnalyser(el);
            el.onplay = () => {
              setSignal({ mode: "speaking", provider: "fal", analyser });
              hooks.onStart();
            };
            el.ontimeupdate = () => {
              if (el.duration > 0) hooks.onProgress?.(el.currentTime / el.duration);
            };
            el.onended = done;
            el.onerror = done;
            await el.play();
            return;
          } catch (elErr) {
            console.warn("sharedMediaElement fallback play failed", elErr);
          }
        }
      }

      // Fallback: Web Speech Synthesis
      if (finished) return;
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
    let localSource: AudioBufferSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let rafId: number | null = null;
    let blobUrlToRevoke: string | null = null;
    let safetyTimer: number | null = null;

    const clearSafetyTimer = () => {
      if (safetyTimer !== null) {
        window.clearTimeout(safetyTimer);
        safetyTimer = null;
      }
    };

    const done = () => {
      if (finished) return;
      finished = true;
      clearSafetyTimer();
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
      hooks?.onEnd?.();
      resolve();
    };

    cancelCurrent = done;

    // Keep play-and-record steady throughout active call on iOS Safari
    if (mobileCallOwnsAudio || (warmMicStream && warmMicStream.active)) {
      unlockAudioSession("play-and-record");
    }

    fetchRemoteTurnAudio(text).then(async (remote) => {
      if (finished) return;

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
          currentAudio = el;
          el.src = blobUrl;

          el.onplay = () => {
            setSignal({ mode: "speaking", provider: "fal", analyser: null });
            pulseVoice();
            hooks?.onStart?.();
          };
          el.ontimeupdate = () => {
            pulseVoice();
            if (el.duration > 0) hooks?.onProgress?.(el.currentTime / el.duration);
          };
          el.onended = () => {
            clearSafetyTimer();
            done();
          };
          el.onerror = () => {
            clearSafetyTimer();
            done();
          };

          safetyTimer = window.setTimeout(() => {
            clearSafetyTimer();
            done();
          }, Math.max(4000, text.length * 95));

          await el.play();
          mediaElementPlayed = true;
          return;
        } catch (elErr) {
          console.warn("sharedMediaElement playback failed, falling back to WebAudio decode", elErr);
          clearSafetyTimer();
          if (blobUrlToRevoke) {
            URL.revokeObjectURL(blobUrlToRevoke);
            blobUrlToRevoke = null;
          }
          currentAudio = null;
        }

        // Secondary path: Web Audio Context decodeAudioData if media element rejected
        if (!finished && !mediaElementPlayed) {
          const ctx = getSharedAudioContext();
          if (ctx) {
            if (ctx.state === "suspended") {
              await ctx.resume().catch(() => {});
            }
            if (finished) return;

            let audioBuf: AudioBuffer | null = null;
            try {
              audioBuf = await ctx.decodeAudioData(buf.slice(0));
            } catch (decodeErr) {
              console.warn("decodeAudioData failed", decodeErr);
            }

            if (audioBuf && !finished) {
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
                  clearSafetyTimer();
                  done();
                };

                safetyTimer = window.setTimeout(() => {
                  clearSafetyTimer();
                  done();
                }, Math.max(4000, Math.round(duration * 1000) + 1200));

                setSignal({ mode: "speaking", provider: "fal", analyser: nodeAnalyser });
                hooks?.onStart?.();

                const updateProgress = () => {
                  if (finished) return;
                  const elapsed = ctx.currentTime - startCtxTime;
                  if (duration > 0) {
                    hooks?.onProgress?.(Math.min(1, elapsed / duration));
                  }
                  if (elapsed < duration) {
                    rafId = requestAnimationFrame(updateProgress);
                  }
                };
                rafId = requestAnimationFrame(updateProgress);

                src.start(0);
                return;
              } catch (playErr) {
                console.warn("AudioBufferSourceNode play failed", playErr);
                clearSafetyTimer();
              }
            }
          }
        }
      }

      // Tertiary fallback: Web Speech Synthesis
      if (finished) return;
      const synth = window.speechSynthesis;
      if (!synth) return done();
      const u = new SpeechSynthesisUtterance(text);
      const calmVoice = pickVoice();
      if (calmVoice) u.voice = calmVoice;
      u.rate = 1.04;
      u.pitch = 1.0;
      u.onstart = () => {
        setSignal({ mode: "speaking", provider: "browser", analyser: null });
        pulseVoice();
        hooks?.onStart?.();
      };
      u.onboundary = (e) => {
        pulseVoice();
        hooks?.onProgress?.(Math.min(1, (e.charIndex + (e.charLength ?? 0)) / text.length));
      };
      u.onend = done;
      u.onerror = done;
      synth.speak(u);
      window.setTimeout(done, Math.max(3800, text.length * 85));
    });
  });
}

export function speakCallTurn(
  speaker: "agent" | "counterparty" | "user",
  text: string,
  hooks?: Partial<SpeechHooks>,
  interrupt = false
) {
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
      sharedMediaElement.pause();
      sharedMediaElement.currentTime = 0;
    } catch {}
  }
  if (currentAudio) {
    try {
      currentAudio.pause();
    } catch {}
    currentAudio = null;
  }
  cancelCurrent?.();
  chain = Promise.resolve();
  endSignal("speaking");
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

  const agentSpeakingRef = useRef(agentSpeaking);
  agentSpeakingRef.current = agentSpeaking;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const speechStartAtRef = useRef<number>(0);
  const lastActiveSpeechAtRef = useRef<number>(0);
  const agentStoppedAtRef = useRef<number>(0);
  const consecutiveSpeechFramesRef = useRef<number>(0);
  const noiseFloorRef = useRef<number>(0.015);
  const calibrationFramesRef = useRef<number>(0);
  const discardCurrentRecordingRef = useRef<boolean>(false);
  const analyserRef = useRef<AnalyserNode | null>(null);

  const setPhase = useCallback((next: AutoVadPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
    onPhaseChangeRef.current?.(next);
  }, []);

  // Track when agent finishes speaking for the 280ms post-TTS cooldown
  useEffect(() => {
    if (!agentSpeaking) {
      agentStoppedAtRef.current = performance.now();
    } else {
      // Recoup began speaking: if we were hearing or manually recording, abort recording to avoid echo
      manualRecordingRef.current = false;
      setManualRecording(false);
      hasSpokenInManualSessionRef.current = false;
      if (phaseRef.current === "hearing") {
        discardCurrentRecordingRef.current = true;
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
          try {
            recorderRef.current.stop();
          } catch {
            // ignore
          }
        }
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

    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try {
        discardCurrentRecordingRef.current = true;
        recorderRef.current.stop();
      } catch {
        // ignore
      }
    }

    manualRecordingRef.current = true;
    hasSpokenInManualSessionRef.current = false;
    setManualRecording(true);
    consecutiveSpeechFramesRef.current = 0;

    const { mimeType, ext } = pickRecorderMimeType();
    chunksRef.current = [];
    discardCurrentRecordingRef.current = false;
    const now = performance.now();
    speechStartAtRef.current = now;
    lastActiveSpeechAtRef.current = now;

    try {
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          chunksRef.current.push(ev.data);
        }
      };
      rec.onstop = () => {
        const wasManual = manualRecordingRef.current;
        manualRecordingRef.current = false;
        setManualRecording(false);
        hasSpokenInManualSessionRef.current = false;

        if (discardCurrentRecordingRef.current) {
          chunksRef.current = [];
          return;
        }
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || mimeType || "audio/mp4" });
        chunksRef.current = [];
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
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.42;
      sourceNode.connect(analyser);
      analyserRef.current = analyser;
    } catch (err) {
      console.warn("Auto-VAD: Could not connect stream to AudioContext analyser", err);
      return;
    }

    setPhase("listening");
    const dataBuffer = new Float32Array(analyser.fftSize);
    let rafId: number | null = null;
    let running = true;

    const vadLoop = () => {
      if (!running) return;

      const now = performance.now();
      const isAgentSpeaking = agentSpeakingRef.current;
      const isMuted = mutedRef.current;
      const isPostTtsCooldown = now - agentStoppedAtRef.current < 680;

      // When Recoup is actively speaking or muted or in cooldown, pause VAD processing
      if (isAgentSpeaking || isMuted || isPostTtsCooldown) {
        consecutiveSpeechFramesRef.current = 0;
        if (analyser) {
          // Do not update voiceSignal with mic when agent is speaking
          if (!isAgentSpeaking && signal.provider !== "fal") {
            setSignal({ mode: "listening", provider: "mic", analyser });
          }
        }
        rafId = requestAnimationFrame(vadLoop);
        return;
      }

      // Read time-domain audio data to calculate RMS
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

      // Keep VoiceOrb reactive to live microphone energy
      if (signal.mode !== "speaking") {
        setSignal({ mode: "listening", provider: "mic", analyser });
        if (rms > 0.02) pulseVoice();
      }

      // Dynamic ambient noise floor calibration over initial frames
      if (calibrationFramesRef.current < 40) {
        calibrationFramesRef.current++;
        noiseFloorRef.current = noiseFloorRef.current * 0.92 + Math.max(0.005, Math.min(0.06, rms)) * 0.08;
      }

      const noiseFloor = noiseFloorRef.current;
      // Sensitive phone VAD thresholds for natural conversational phone speech
      const speechStartThreshold = Math.max(0.012, noiseFloor * 1.8);
      const silenceThreshold = Math.max(0.008, noiseFloor * 1.3);

      const currentPhase = phaseRef.current;

      if (currentPhase === "listening") {
        if (rms > speechStartThreshold) {
          consecutiveSpeechFramesRef.current++;
          // ~100ms consecutive speech validation (~6 frames at 60Hz)
          if (consecutiveSpeechFramesRef.current >= 6) {
            consecutiveSpeechFramesRef.current = 0;
            const { mimeType, ext } = pickRecorderMimeType();
            chunksRef.current = [];
            discardCurrentRecordingRef.current = false;
            speechStartAtRef.current = now;
            lastActiveSpeechAtRef.current = now;
            manualRecordingRef.current = false;
            hasSpokenInManualSessionRef.current = true;

            try {
              const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
              rec.ondataavailable = (ev) => {
                if (ev.data && ev.data.size > 0) {
                  chunksRef.current.push(ev.data);
                }
              };
              rec.onstop = () => {
                const wasManual = manualRecordingRef.current;
                manualRecordingRef.current = false;
                setManualRecording(false);
                hasSpokenInManualSessionRef.current = false;

                if (discardCurrentRecordingRef.current) {
                  chunksRef.current = [];
                  return;
                }
                const blob = new Blob(chunksRef.current, { type: rec.mimeType || mimeType || "audio/mp4" });
                chunksRef.current = [];
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
            } catch (recErr) {
              console.warn("Auto-VAD: MediaRecorder start failed", recErr);
            }
          }
        } else {
          consecutiveSpeechFramesRef.current = Math.max(0, consecutiveSpeechFramesRef.current - 1);
        }
      } else if (currentPhase === "hearing") {
        if (rms >= speechStartThreshold) {
          hasSpokenInManualSessionRef.current = true;
          lastActiveSpeechAtRef.current = now;
        } else if (rms >= silenceThreshold && hasSpokenInManualSessionRef.current) {
          lastActiveSpeechAtRef.current = now;
        }

        const silenceDuration = hasSpokenInManualSessionRef.current
          ? now - lastActiveSpeechAtRef.current
          : manualRecordingRef.current
          ? 0
          : now - speechStartAtRef.current;
        const totalDuration = now - speechStartAtRef.current;

        // Auto-complete turn when 850ms silence occurs after speech OR 11s safety cap reached
        if (
          (hasSpokenInManualSessionRef.current && silenceDuration >= 850 && totalDuration >= 300) ||
          totalDuration >= 11000
        ) {
          setPhase("syncing");
          if (recorderRef.current && recorderRef.current.state === "recording") {
            try {
              recorderRef.current.stop();
            } catch {
              setPhase("listening");
            }
          }
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
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        try {
          discardCurrentRecordingRef.current = true;
          recorderRef.current.stop();
        } catch {
          // ignore
        }
      }
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
