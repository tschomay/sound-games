/**
 * A hand-built stand-in for the pieces of Web Audio this codebase touches.
 * jsdom has no real implementation, and pulling in a polyfill for a handful of
 * nodes is not worth a new dependency (see AGENTS.md conventions) — this is
 * enough surface for `OutputBus` and `Analyser` to run against in a test.
 */

class FakeAudioParam {
  value = 0;
}

class FakeGainNode {
  readonly gain = new FakeAudioParam();
  connect(): void {}
  disconnect(): void {}
}

class FakeBufferSourceNode {
  buffer: unknown = null;
  loop = false;
  onended: (() => void) | null = null;
  private started = false;
  connect(): void {}
  disconnect(): void {}
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.started = false;
  }
  get isStarted(): boolean {
    return this.started;
  }
}

/** A frequency-domain / time-domain source the test controls frame by frame. */
export class FakeAnalyserNode {
  fftSize = 2048;
  frequencyBinCount = 1024;
  smoothingTimeConstant = 0;
  minDecibels = -100;
  /** dBFS every bin is set to on the next `getFloatFrequencyData` call. */
  spectrumDb = -100;
  /** Amplitude every sample is set to on the next `getFloatTimeDomainData` call. */
  amplitude = 0;

  connect(): void {}
  disconnect(): void {}

  getFloatTimeDomainData(out: Float32Array): void {
    out.fill(this.amplitude);
  }

  getFloatFrequencyData(out: Float32Array): void {
    out.fill(this.spectrumDb);
  }
}

class FakeAudioNode {
  connect(): void {}
  disconnect(): void {}
}

/**
 * Enough of `AudioContext` for `OutputBus` and `Analyser` to construct and run
 * against, with a `currentTime` the test advances explicitly instead of a real
 * clock.
 */
export class FakeAudioContext {
  currentTime = 0;
  readonly destination = new FakeAudioNode();
  readonly analyserNode = new FakeAnalyserNode();

  createGain(): FakeGainNode {
    return new FakeGainNode();
  }

  createBufferSource(): FakeBufferSourceNode {
    return new FakeBufferSourceNode();
  }

  createAnalyser(): FakeAnalyserNode {
    return this.analyserNode;
  }

  advance(seconds: number): void {
    this.currentTime += seconds;
  }
}

export function fakeAudioSource(context: FakeAudioContext): {
  kind: 'mic';
  label: string;
  context: AudioContext;
  node: AudioNode;
  stop(): void;
} {
  return {
    kind: 'mic',
    label: 'fake',
    context: context as unknown as AudioContext,
    node: new FakeAudioNode() as unknown as AudioNode,
    stop() {},
  };
}
