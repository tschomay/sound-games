/**
 * Per-device latency compensation, measured once, applied everywhere.
 *
 * `docs/ideas.md` is explicit that voice-input detection latency (30–45ms to a
 * confident pitch, 10–20ms to a clap — see `README.md`'s "Design notes") is a
 * *given*, not something a device adds on top. What varies by device is
 * round-trip audio latency: the gap between this app scheduling a sound
 * through the output bus and a listening microphone actually hearing it,
 * which depends on the specific phone/laptop/headphones/OS audio stack. Two
 * games — Rhythm-Gated Combat and Drop Siege — judge a tap against a beat
 * instant, so a device with unusually high output-to-input latency makes an
 * objectively well-timed tap read as late (see `analyser.ts`'s doc comment on
 * where the resulting compensation is actually applied).
 *
 * This module is a loopback test: play a click through the output bus, time
 * how long it takes a fresh `OnsetDetector` — fed the analyser's *raw*
 * spectrum, not `Frame.onset`, which the output bus's own suppression window
 * would force to `false` for exactly the click being measured (ADR-0005) — to
 * hear it arrive, using the shared `AudioContext`'s own clock
 * (`context.currentTime`) so the measurement isn't polluted by JS scheduling
 * jitter. It only measures what it can: a real loopback requires sound to
 * actually leave a speaker and re-enter a live microphone, which is why this
 * is built and unit-tested against synthetic timing/spectra here, but its
 * real-world accuracy on actual hardware is unverified in this environment —
 * see `docs/roadmap.md`'s Phase 9 section.
 *
 * **What the single measured number can't distinguish.** It conflates output
 * scheduling delay (this device's own speaker/DAC latency — the whole of what
 * matters for a file source, where this device is also the one playing the
 * track) with input-side latency (mic buffering, analyser buffering — the
 * only part that's relevant when the "music" being tracked is external audio
 * a room mic is merely overhearing). There is no loopback-only way to split
 * those two apart, so both games apply the one measured value uniformly and
 * this limitation is documented rather than hidden.
 */
import { OnsetDetector } from './onset';
import type { OutputBus } from './output';

export interface LatencyMeasurementOptions {
  /** How many clean measurements to take before settling on a number. */
  trials?: number;
  /** How long to wait for a single click to be heard before giving up on it. */
  timeoutSeconds?: number;
  /** Gap between the end of one trial and the start of the next. */
  gapSeconds?: number;
  /** Warmup before the very first click, so the onset detector's rolling
   *  threshold isn't still `Infinity` (see `OnsetDetector.threshold`) when the
   *  click most needs to be heard. */
  warmupSeconds?: number;
  toneHz?: number;
  toneSeconds?: number;
  /** Clean measurements required before reporting a result at all — one lucky
   *  or unlucky trial shouldn't set a number applied to every future round. */
  minSamples?: number;
}

const DEFAULTS = {
  trials: 5,
  timeoutSeconds: 1.5,
  gapSeconds: 0.6,
  warmupSeconds: 0.3,
  toneHz: 1200,
  toneSeconds: 0.03,
  minSamples: 2,
} as const;

/**
 * One trial's state machine — "a click was played, waiting to hear it arrive"
 * — with no Web Audio in it at all, so it's unit-testable with plain numbers.
 */
export class LatencyTrial {
  private playedAt: number | null = null;
  private deadline: number | null = null;

  constructor(private readonly timeoutSeconds: number = DEFAULTS.timeoutSeconds) {}

  get isRunning(): boolean {
    return this.playedAt !== null;
  }

  /** Call right after scheduling the click to play, with the clock reading at
   *  that instant. */
  begin(now: number): void {
    this.playedAt = now;
    this.deadline = now + this.timeoutSeconds;
  }

  /**
   * Feed this once per frame while running. Returns the measured latency in
   * seconds the moment an onset is seen, `'timeout'` once the window closes
   * with nothing detected, or `null` while still waiting.
   */
  sample(now: number, onsetDetected: boolean): number | 'timeout' | null {
    if (this.playedAt === null) return null;
    if (onsetDetected) {
      const latency = now - this.playedAt;
      this.playedAt = null;
      this.deadline = null;
      return latency;
    }
    if (this.deadline !== null && now >= this.deadline) {
      this.playedAt = null;
      this.deadline = null;
      return 'timeout';
    }
    return null;
  }
}

/**
 * Aggregate several trials into one number. The median, not the mean, so a
 * single outlier (a passing noise, a missed onset that ran to the very edge
 * of its window) doesn't drag the result — and `null` rather than a number
 * built from too little evidence when fewer than `minSamples` trials came
 * back clean.
 */
export function summariseLatency(
  samplesSeconds: number[],
  minSamples: number = DEFAULTS.minSamples,
): number | null {
  if (samplesSeconds.length < minSamples) return null;
  const sorted = [...samplesSeconds].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * A short, sharp click: a single half-sine-enveloped tone burst. Short enough
 * not to blur the arrival instant the onset detector has to pin down, and
 * enveloped so it reads as one transient rather than popping across two.
 */
export function createClickBuffer(
  context: { sampleRate: number; createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer },
  options: LatencyMeasurementOptions = {},
): AudioBuffer {
  const hz = options.toneHz ?? DEFAULTS.toneHz;
  const seconds = options.toneSeconds ?? DEFAULTS.toneSeconds;
  const length = Math.max(1, Math.round(context.sampleRate * seconds));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const envelope = Math.sin((Math.PI * i) / length);
    data[i] = envelope * Math.sin((2 * Math.PI * hz * i) / context.sampleRate);
  }
  return buffer;
}

/**
 * Runs the whole loopback measurement: plays `trials` clicks through the
 * output bus a `gapSeconds` apart, and times each one's arrival with a
 * dedicated `OnsetDetector` fed the analyser's raw spectrum every frame — see
 * the module doc comment for why not `Frame.onset`. Drive it by calling
 * `step()` once per animation frame with the shared context's clock and the
 * analyser's current spectrum; it owns its own trial sequencing and reports
 * `finished` once enough clean measurements are in or every trial has
 * exhausted its timeout.
 */
export class LoopbackLatencyMeasurement {
  private readonly trial: LatencyTrial;
  private readonly samples: number[] = [];
  private trialsRun = 0;
  private nextTrialAt: number | null = null;
  private done = false;

  constructor(
    private readonly output: OutputBus,
    private readonly buffer: AudioBuffer,
    private readonly onsetDetector: OnsetDetector,
    private readonly options: LatencyMeasurementOptions = {},
  ) {
    this.trial = new LatencyTrial(options.timeoutSeconds ?? DEFAULTS.timeoutSeconds);
  }

  get finished(): boolean {
    return this.done;
  }

  /** The final measured latency in seconds once finished — `null` either
   *  while still running or if too few trials came back clean. */
  get result(): number | null {
    return this.done ? summariseLatency(this.samples, this.options.minSamples ?? DEFAULTS.minSamples) : null;
  }

  get progress(): { trialsRun: number; trials: number; samples: number } {
    return {
      trialsRun: this.trialsRun,
      trials: this.options.trials ?? DEFAULTS.trials,
      samples: this.samples.length,
    };
  }

  /** Call once per animation frame with the shared context's current clock
   *  and the analyser's raw spectrum (dBFS, as `getFloatFrequencyData`
   *  returns — e.g. `analyser.spectrumView()`). */
  step(now: number, spectrum: Float32Array): void {
    if (this.done) return;
    const totalTrials = this.options.trials ?? DEFAULTS.trials;

    // Fed every frame, running or not, exactly like `Analyser` feeds its own
    // onset detector — its rolling flux history has to be warm by the time a
    // click actually needs detecting.
    const onset = this.onsetDetector.process(spectrum, now);

    if (this.nextTrialAt === null) this.nextTrialAt = now + (this.options.warmupSeconds ?? DEFAULTS.warmupSeconds);

    if (!this.trial.isRunning && this.trialsRun < totalTrials && now >= this.nextTrialAt) {
      this.output.playSfx(this.buffer);
      this.trial.begin(now);
    }

    if (this.trial.isRunning) {
      const outcome = this.trial.sample(now, onset.onset);
      if (outcome !== null) {
        this.trialsRun++;
        if (outcome !== 'timeout') this.samples.push(outcome);
        this.nextTrialAt = now + (this.options.gapSeconds ?? DEFAULTS.gapSeconds);
      }
    }

    if (this.trialsRun >= totalTrials) this.done = true;
  }
}
