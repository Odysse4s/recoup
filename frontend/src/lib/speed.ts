export type Speed = "1x" | "2x" | "turbo";

export interface PaceProfile {
  label: string;
  /** Delay between paced SSE events. */
  eventMs: number;
  /** Live window lifecycle: origin pop → typewriter → hold → genie dock. */
  pop: number;
  type: number;
  hold: number;
  dock: number;
  rewind: number;
}

export const PACE: Record<Speed, PaceProfile> = {
  "1x": { label: "1x", eventMs: 1400, pop: 700, type: 3200, hold: 600, dock: 800, rewind: 2800 },
  "2x": { label: "2x", eventMs: 700, pop: 450, type: 1600, hold: 300, dock: 600, rewind: 1800 },
  turbo: { label: "Turbo", eventMs: 140, pop: 260, type: 520, hold: 120, dock: 380, rewind: 1000 },
};
