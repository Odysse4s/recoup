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

export function unlockAudioSession(): AudioContext | null {
  if (typeof window === "undefined") return null;

  // 1. Web Audio Context
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

  // 2. Prime silent <audio> element to unlock iOS media playback
  try {
    const silentAudio = new Audio();
    silentAudio.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
    silentAudio.volume = 0.01;
    silentAudio.play().then(() => {
      silentAudio.pause();
    }).catch(() => {});
  } catch {
    // Ignore silent audio prime error
  }

  // 3. Unlock SpeechSynthesis
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
  return sharedAudioContext || unlockAudioSession();
}

export async function getWarmMicStream(): Promise<MediaStream | null> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    console.warn("getWarmMicStream permission or hardware error", err);
    return null;
  }
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

async function tryRemoteTurnAudio(text: string): Promise<HTMLAudioElement | null> {
  try {
    const res = await fetch("/api/voice/turn-audio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speaker: "agent", text }),
    });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || res.status === 204 || !type.startsWith("audio")) {
      return null;
    }
    const blob = await res.blob();
    return new Audio(URL.createObjectURL(blob));
  } catch {
    return null;
  }
}

async function tryRemote(text: string, kind: string): Promise<HTMLAudioElement | null> {
  if (Date.now() < remoteRetryAfter) return null;
  try {
    const res = await fetch("/api/voice/briefing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, kind }),
    });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || res.status === 204 || !type.startsWith("audio")) {
      return null;
    }
    remoteRetryAfter = 0;
    const blob = await res.blob();
    return new Audio(URL.createObjectURL(blob));
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
    let audio: HTMLAudioElement | null = null;
    let analyser: AnalyserNode | null = null;
    const done = () => {
      if (finished) return;
      finished = true;
      if (cancelCurrent === done) cancelCurrent = null;
      if (audio) {
        audio.onplay = audio.ontimeupdate = audio.onended = audio.onerror = null;
        if (currentAudio === audio) currentAudio = null;
        if (audio.src.startsWith("blob:")) URL.revokeObjectURL(audio.src);
      }
      analyser?.disconnect();
      endSignal("speaking");
      hooks.onEnd();
      resolve();
    };
    cancelCurrent = done;
    tryRemote(text, kind).then((remote) => {
      if (finished) {
        if (remote?.src.startsWith("blob:")) URL.revokeObjectURL(remote.src);
        return;
      }
      if (remote) {
        const el = remote;
        audio = el;
        currentAudio = el;
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
        el.play().catch(done);
        return;
      }
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
    let audio: HTMLAudioElement | null = null;
    let analyser: AnalyserNode | null = null;
    const done = () => {
      if (finished) return;
      finished = true;
      if (cancelCurrent === done) cancelCurrent = null;
      if (audio) {
        audio.onplay = audio.ontimeupdate = audio.onended = audio.onerror = null;
        if (currentAudio === audio) currentAudio = null;
        if (audio.src.startsWith("blob:")) URL.revokeObjectURL(audio.src);
      }
      analyser?.disconnect();
      endSignal("speaking");
      hooks?.onEnd?.();
      resolve();
    };
    cancelCurrent = done;
    tryRemoteTurnAudio(text).then((remote) => {
      if (finished) {
        if (remote?.src.startsWith("blob:")) URL.revokeObjectURL(remote.src);
        return;
      }
      if (remote) {
        const el = remote;
        audio = el;
        currentAudio = el;
        analyser = soundFx.attachVoiceAnalyser(el);
        el.onplay = () => {
          setSignal({ mode: "speaking", provider: "fal", analyser });
          hooks?.onStart?.();
        };
        el.ontimeupdate = () => {
          if (el.duration > 0) hooks?.onProgress?.(el.currentTime / el.duration);
        };
        el.onended = done;
        el.onerror = done;
        el.play().catch(done);
        return;
      }
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
  if (!interrupt && cleanText === lastTurnKey && now - lastTurnAt < 2000) {
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
  if (currentAudio) {
    currentAudio.pause();
  }
  cancelCurrent?.();
  currentAudio = null;
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

export function useAutoVad({
  stream,
  enabled,
  agentSpeaking,
  muted,
  onUtterance,
  onPhaseChange,
  onRms,
}: UseAutoVadOptions) {
  const [phase, setPhaseState] = useState<AutoVadPhase>("idle");
  const [rmsLevel, setRmsLevel] = useState(0);

  const phaseRef = useRef<AutoVadPhase>("idle");
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
      // Recoup began speaking: if we were hearing something, abort recording to avoid echo
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

  // Center orb tap shortcut: send utterance immediately if currently hearing
  const sendNow = useCallback(() => {
    if (phaseRef.current === "hearing" && recorderRef.current && recorderRef.current.state === "recording") {
      pulseVoice();
      setPhase("syncing");
      try {
        recorderRef.current.stop();
      } catch {
        setPhase("listening");
      }
    }
  }, [setPhase]);

  useEffect(() => {
    if (!enabled || !stream) {
      setPhase("idle");
      setRmsLevel(0);
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        try {
          recorderRef.current.stop();
        } catch {
          // ignore
        }
      }
      return;
    }

    const ctx = unlockAudioSession();
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
      const speechStartThreshold = Math.max(0.026, noiseFloor * 2.2);
      const silenceThreshold = Math.max(0.016, noiseFloor * 1.5);

      const currentPhase = phaseRef.current;

      if (currentPhase === "listening") {
        if (rms > speechStartThreshold) {
          consecutiveSpeechFramesRef.current++;
          // ~180ms consecutive speech validation (~11 frames at 60Hz)
          if (consecutiveSpeechFramesRef.current >= 10) {
            consecutiveSpeechFramesRef.current = 0;
            const { mimeType, ext } = pickRecorderMimeType();
            chunksRef.current = [];
            discardCurrentRecordingRef.current = false;
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
                if (discardCurrentRecordingRef.current) {
                  chunksRef.current = [];
                  return;
                }
                const blob = new Blob(chunksRef.current, { type: rec.mimeType || mimeType || "audio/mp4" });
                chunksRef.current = [];
                const totalSpeechDuration = lastActiveSpeechAtRef.current - speechStartAtRef.current;
                if (blob.size >= 1200 && totalSpeechDuration >= 320) {
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
        if (rms >= silenceThreshold) {
          lastActiveSpeechAtRef.current = now;
        }

        const silenceDuration = now - lastActiveSpeechAtRef.current;
        const totalDuration = now - speechStartAtRef.current;

        // Auto-complete turn when 850ms silence occurs OR 11s safety cap reached
        if ((silenceDuration >= 850 && totalDuration >= 350) || totalDuration >= 11000) {
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
    analyser: analyserRef.current,
  };
}
