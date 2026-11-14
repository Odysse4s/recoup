import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { soundFx } from "./sound";

/* ------------------------------------------------------------------------
   Voice signal: what the frequency radar (VoiceOrb) visualises.
   `analyser` is set for real audio (ElevenLabs briefing); otherwise the radar
   synthesises a spectrum from speech cadence (word boundaries / mic results).
   ------------------------------------------------------------------------ */

export interface VoiceSignal {
  mode: "idle" | "speaking" | "listening";
  provider: "elevenlabs" | "browser" | "mic" | null;
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

/* ------------------------------------------------------------------------
   Voice briefing output: ElevenLabs via /api/voice/briefing when available,
   otherwise falls back cleanly to browser Web Speech synthesis.
   ------------------------------------------------------------------------ */

let remoteRetryAfter = 0;
let currentAudio: HTMLAudioElement | null = null;
let chain: Promise<void> = Promise.resolve();
let generation = 0;
let cancelCurrent: (() => void) | null = null;

function pickVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  const preferred = [
    "Microsoft Aria Online (Natural)",
    "Microsoft Jenny Online (Natural)",
    "Microsoft Guy Online (Natural)",
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
  return voices.find((v) => v.lang?.startsWith("en") && v.name.includes("Natural")) ?? voices.find((v) => v.lang?.startsWith("en"));
}

function pickCounterpartyVoice(agentVoice?: SpeechSynthesisVoice): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  const preferred = [
    "Microsoft Guy Online (Natural)",
    "Microsoft Ryan Online (Natural)",
    "Google UK English Male",
    "Google UK English Female",
    "Daniel",
    "Alex",
    "Aaron",
    "Fred",
  ];
  for (const name of preferred) {
    const v = voices.find((x) => x.name.includes(name) && x.name !== agentVoice?.name);
    if (v) return v;
  }
  return voices.find((v) => v.lang?.startsWith("en") && v.name !== agentVoice?.name) ?? agentVoice;
}

async function tryRemoteTurnAudio(speaker: "agent" | "counterparty", text: string): Promise<HTMLAudioElement | null> {
  try {
    const res = await fetch("/api/voice/turn-audio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speaker, text }),
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
          setSignal({ mode: "speaking", provider: "elevenlabs", analyser });
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
      u.pitch = 1;
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

function speakTurnOnce(speaker: "agent" | "counterparty", text: string, hooks?: Partial<SpeechHooks>) {
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
    tryRemoteTurnAudio(speaker, text).then((remote) => {
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
          setSignal({ mode: "speaking", provider: "elevenlabs", analyser });
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
      const agentVoice = pickVoice();
      const chosen = speaker === "agent" ? agentVoice : pickCounterpartyVoice(agentVoice);
      if (chosen) u.voice = chosen;
      // Dual-pitch Web Speech fallback distinguishes Recoup Negotiator vs Vendor AR Desk
      u.rate = speaker === "agent" ? 1.06 : 0.98;
      u.pitch = speaker === "agent" ? 1.06 : 0.85;
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
  speaker: "agent" | "counterparty",
  text: string,
  hooks?: Partial<SpeechHooks>,
  interrupt = false
) {
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
    return speakTurnOnce(speaker, text, {
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
