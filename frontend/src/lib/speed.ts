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
  "1x": { label: "1x", eventMs: 1950, pop: 800, type: 4200, hold: 1500, dock: 900, rewind: 3000 },
  "2x": { label: "2x", eventMs: 975, pop: 500, type: 2100, hold: 750, dock: 650, rewind: 1900 },
  turbo: { label: "Turbo", eventMs: 180, pop: 280, type: 600, hold: 220, dock: 400, rewind: 1050 },
};
