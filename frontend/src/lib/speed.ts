export type Speed = "0.5x" | "1x" | "2x" | "turbo";

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
  /** Pacing duration aliases */
  typeMs?: number;
  holdMs?: number;
}

export const PACE: Record<Speed, PaceProfile> = {
  "0.5x": {
    label: "0.5x",
    eventMs: 1040,
    pop: 500,
    type: 1300,
    hold: 1900,
    dock: 700,
    rewind: 2600,
    typeMs: 1300,
    holdMs: 1900,
  },
  "1x": {
    label: "1x",
    eventMs: 520,
    pop: 320,
    type: 650,
    hold: 950,
    dock: 450,
    rewind: 1600,
    typeMs: 650,
    holdMs: 950,
  },
  "2x": {
    label: "2x",
    eventMs: 260,
    pop: 200,
    type: 325,
    hold: 475,
    dock: 300,
    rewind: 1000,
    typeMs: 325,
    holdMs: 475,
  },
  turbo: {
    label: "Turbo",
    eventMs: 120,
    pop: 150,
    type: 180,
    hold: 220,
    dock: 220,
    rewind: 600,
    typeMs: 180,
    holdMs: 220,
  },
};
