/**
 * Hum Flyer's rules, kept free of rendering and of the microphone so the whole
 * thing can be reasoned about (and later tested) by feeding it numbers.
 *
 * The flyer's height is your pitch. Gates open at the pitch of a melody note, so
 * flying the course well means singing the tune — the course *is* the song.
 */

export interface Gate {
  /** Distance along the course, in world units. */
  x: number;
  /** Gap centre, 0 (bottom of range) to 1 (top). */
  centre: number;
  /** Half the gap height, in the same 0..1 space. */
  halfGap: number;
  /** Index into the melody's scale, for labelling. */
  degree: number;
  passed: boolean;
  cleared: boolean;
}

export interface Melody {
  name: string;
  /** Scale degrees; 0 is the bottom of the playable band. */
  degrees: number[];
  /** How many degrees the scale spans, top to bottom. */
  steps: number;
}

export const MELODIES: Melody[] = [
  {
    name: 'Ode to Joy',
    degrees: [2, 2, 3, 4, 4, 3, 2, 1, 0, 0, 1, 2, 2, 1, 1],
    steps: 5,
  },
  {
    name: 'Twinkle',
    degrees: [0, 0, 4, 4, 5, 5, 4, 3, 3, 2, 2, 1, 1, 0],
    steps: 6,
  },
];

export interface Config {
  /** World units between gates. */
  spacing: number;
  /** World units per second at the start of a round. */
  startSpeed: number;
  /** Extra speed per gate cleared. */
  speedPerGate: number;
  maxSpeed: number;
  startHalfGap: number;
  minHalfGap: number;
  /** How much the gap tightens per gate cleared. */
  gapDecay: number;
  /** How fast the flyer chases your pitch. Higher is twitchier. */
  responsiveness: number;
  /** Fall rate in 0..1 units per second squared when you stop making a sound. */
  gravity: number;
  /** Flyer radius in 0..1 units, for collision. */
  radius: number;
}

export const DEFAULT_CONFIG: Config = {
  spacing: 0.62,
  startSpeed: 0.5,
  speedPerGate: 0.008,
  maxSpeed: 0.95,
  startHalfGap: 0.15,
  minHalfGap: 0.075,
  gapDecay: 0.0022,
  responsiveness: 9,
  gravity: 0.55,
  radius: 0.035,
};

export type Phase = 'ready' | 'flying' | 'crashed';

/** What the game needs from a Frame — nothing more, so tests need no audio. */
export interface Input {
  voiced: boolean;
  pitchNorm: number | null;
  level: number;
}

export class HumFlyer {
  phase: Phase = 'ready';
  /** Flyer height, 0 at the bottom of the band, 1 at the top. */
  height = 0.5;
  score = 0;
  best = 0;
  /** How far the course has scrolled, in world units. */
  distance = 0;
  gates: Gate[] = [];
  melody: Melody;
  /** Set on the frame a gate is cleared, for the hit effect. Decays to zero. */
  celebration = 0;

  private velocity = 0;
  private nextGateIndex = 0;
  private silentFor = 0;

  constructor(
    readonly config: Config = DEFAULT_CONFIG,
    melodyIndex = 0,
  ) {
    this.melody = MELODIES[melodyIndex % MELODIES.length];
    this.reset();
  }

  reset(): void {
    this.phase = 'ready';
    this.height = 0.5;
    this.velocity = 0;
    this.score = 0;
    this.distance = 0;
    this.nextGateIndex = 0;
    this.silentFor = 0;
    this.celebration = 0;
    this.gates = [];
    // A little clear air before the first gate, so a round never opens with a
    // crash you had no chance to avoid — but not so much that it opens on an
    // empty screen, which reads as the game being broken.
    for (let i = 0; i < 8; i++) {
      this.spawnGate((1.6 + i) * this.config.spacing);
    }
  }

  /** Height the gap of gate `index` sits at, from the melody. */
  private centreFor(index: number): number {
    const degree = this.melody.degrees[index % this.melody.degrees.length];
    const span = Math.max(1, this.melody.steps - 1);
    // Keep gates off the very edges: pinning someone at the top of their range
    // for a whole gate is exhausting, and unreachable at the bottom.
    return 0.16 + (degree / span) * 0.68;
  }

  private spawnGate(x: number): void {
    const index = this.nextGateIndex++;
    this.gates.push({
      x,
      centre: this.centreFor(index),
      halfGap: Math.max(
        this.config.minHalfGap,
        this.config.startHalfGap - index * this.config.gapDecay,
      ),
      degree: this.melody.degrees[index % this.melody.degrees.length],
      passed: false,
      cleared: false,
    });
  }

  speed(): number {
    return Math.min(
      this.config.maxSpeed,
      this.config.startSpeed + this.score * this.config.speedPerGate,
    );
  }

  /** The gate the flyer is heading for, or null past the end of the spawned run. */
  nextGate(): Gate | null {
    for (const gate of this.gates) {
      if (!gate.passed) return gate;
    }
    return null;
  }

  update(dt: number, input: Input): void {
    this.celebration = Math.max(0, this.celebration - dt * 3);

    if (this.phase === 'ready') {
      // A round starts when you start humming — no button, because the whole
      // point is that your voice is the controller.
      this.follow(dt, input);
      if (input.voiced && input.pitchNorm !== null) this.phase = 'flying';
      return;
    }
    if (this.phase !== 'flying') return;

    this.follow(dt, input);
    this.scroll(dt);
    this.collide();
  }

  private follow(dt: number, input: Input): void {
    if (input.voiced && input.pitchNorm !== null) {
      this.silentFor = 0;
      this.velocity = 0;
      // Exponential chase rather than a hard set: pitch detection jitters by a
      // few cents frame to frame, and a hard set turns that jitter into a
      // vibrating flyer.
      const blend = 1 - Math.exp(-this.config.responsiveness * dt);
      this.height += (input.pitchNorm - this.height) * blend;
      return;
    }

    // A short grace period, because taking a breath shouldn't drop you.
    this.silentFor += dt;
    if (this.silentFor < 0.18) return;
    this.velocity += this.config.gravity * dt;
    this.height -= this.velocity * dt;

    if (this.height <= 0) {
      this.height = 0;
      if (this.phase === 'flying') this.phase = 'crashed';
    }
  }

  private scroll(dt: number): void {
    this.distance += this.speed() * dt;

    const last = this.gates[this.gates.length - 1];
    if (last && last.x - this.distance < 6 * this.config.spacing) {
      this.spawnGate(last.x + this.config.spacing);
    }
    // Drop gates well behind the flyer so the array can't grow without bound.
    while (this.gates.length > 0 && this.gates[0].x - this.distance < -1) {
      this.gates.shift();
    }
  }

  private collide(): void {
    const { radius } = this.config;
    for (const gate of this.gates) {
      const relative = gate.x - this.distance;
      if (relative > radius) break;

      if (!gate.passed && relative < -radius) {
        gate.passed = true;
        if (gate.cleared) {
          this.score++;
          this.best = Math.max(this.best, this.score);
          this.celebration = 1;
        }
        continue;
      }

      // Inside the gate's column: the gap has to contain the whole flyer.
      if (relative <= radius && relative >= -radius) {
        const offset = Math.abs(this.height - gate.centre);
        if (offset + radius > gate.halfGap) {
          this.phase = 'crashed';
          return;
        }
        gate.cleared = true;
      }
    }

    if (this.height >= 1) this.height = 1;
  }
}
