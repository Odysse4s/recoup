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
  forgeTypeMs?: number;
  forgeHoldMs?: number;
  minWindowGapMs?: number;
}

export const PACE: Record<Speed, PaceProfile> = {
  "0.5x": {
    label: "0.5x",
    eventMs: 1900,
    pop: 500,
    type: 2600,
    hold: 4200,
    dock: 700,
    rewind: 2600,
    typeMs: 2600,
    holdMs: 4200,
    forgeTypeMs: 2900,
    forgeHoldMs: 3800,
    minWindowGapMs: 3200,
  },
  "1x": {
    label: "1x",
    eventMs: 1100,
    pop: 320,
    type: 1900,
    hold: 4800,
    dock: 460,
    rewind: 1600,
    typeMs: 1900,
    holdMs: 4800,
    forgeTypeMs: 2300,
    forgeHoldMs: 4400,
    minWindowGapMs: 2500,
  },
  "2x": {
    label: "2x",
    eventMs: 475,
    pop: 200,
    type: 750,
    hold: 1200,
    dock: 300,
    rewind: 1000,
    typeMs: 750,
    holdMs: 1200,
    forgeTypeMs: 850,
    forgeHoldMs: 1100,
    minWindowGapMs: 1250,
  },
  turbo: {
    label: "Turbo",
    eventMs: 160,
    pop: 150,
    type: 300,
    hold: 450,
    dock: 220,
    rewind: 600,
    typeMs: 300,
    holdMs: 450,
    forgeTypeMs: 350,
    forgeHoldMs: 400,
    minWindowGapMs: 550,
  },
};
