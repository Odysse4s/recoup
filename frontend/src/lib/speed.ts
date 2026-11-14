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
  },
  "1x": {
    label: "1x",
    eventMs: 950,
    pop: 320,
    type: 1500,
    hold: 2400,
    dock: 460,
    rewind: 1600,
    typeMs: 1500,
    holdMs: 2400,
    forgeTypeMs: 1700,
    forgeHoldMs: 2200,
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
  },
};
