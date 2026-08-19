/**
 * Calibration flow. See ADR-0003 — this measures the numbers every game then
 * normalises against: the room's noise floor, the player's comfortable loudness,
 * and the top and bottom of their hum.
 */
import { ensureMicSession, refreshProfile, stopSession } from '../engine/session';
import { padPitchRange, saveProfile } from '../engine/calibration';
import { hzToNote } from '../engine/pitch';
import { startLoop } from '../engine/canvas';
import { el, navigate, overlay, topbar, type Cleanup } from '../ui';
import type { Frame } from '../engine/types';

interface Step {
  id: 'silence' | 'loud' | 'low' | 'high';
  title: string;
  instruction: string;
  /** Seconds of usable samples needed before the step is satisfied. */
  needed: number;
  /** Seconds before we give up and offer a retry. */
  timeout: number;
  usable(frame: Frame, noiseFloorDb: number): boolean;
}

const STEPS: Step[] = [
  {
    id: 'silence',
    title: 'Silence',
    instruction: 'Stay quiet for a moment so we can hear how noisy your room is.',
    needed: 2,
    timeout: 6,
    usable: () => true,
  },
  {
    id: 'loud',
    title: 'Comfortable volume',
    instruction: 'Now hum steadily, at a volume you could keep up for a whole game.',
    needed: 1.5,
    timeout: 12,
    usable: (frame, floor) => frame.db > floor + 6,
  },
  {
    id: 'low',
    title: 'Your lowest note',
    instruction: 'Hum the lowest note you can hold comfortably.',
    needed: 1,
    timeout: 14,
    usable: (frame) => frame.voiced && frame.clarity > 0.9,
  },
  {
    id: 'high',
    title: 'Your highest note',
    instruction: 'Now hum the highest note you can hold comfortably. No need to strain.',
    needed: 1,
    timeout: 14,
    usable: (frame) => frame.voiced && frame.clarity > 0.9,
  },
];

/** A second of lead-in per step, so we're not recording the tap that started it. */
const LEAD_IN = 1;

export function calibrateScreen(root: HTMLElement): Cleanup {
  const stage = el('div', { class: 'stage' });
  const body = el('div', { class: 'stack' });
  stage.appendChild(body);

  const screen = el('div', { class: 'screen' }, topbar('Calibrate'), stage);
  root.appendChild(screen);

  let stopRendering: (() => void) | null = null;
  let disposed = false;

  const gate = overlay(
    'Calibration takes about twenty seconds: a moment of quiet, then three hums.',
    'Start',
    () => void begin(),
    'Your audio is analysed on your device and never leaves it.',
  );
  stage.appendChild(gate.root);

  async function begin(): Promise<void> {
    gate.setBusy(true);
    try {
      const session = await ensureMicSession();
      if (disposed) return;
      gate.root.remove();
      stopRendering = run(session.analyser.read.bind(session.analyser));
    } catch (error) {
      gate.showError(error instanceof Error ? error.message : 'Could not open the microphone.');
    }
  }

  function run(readFrame: () => Frame): () => void {
    let stepIndex = 0;
    let elapsed = 0;
    const collected: number[] = [];
    const measurements = { noiseFloorDb: -65, loudDb: -22, lowHz: 110, highHz: 440 };

    const title = el('h1', { text: STEPS[0].title });
    const instruction = el('p', { text: STEPS[0].instruction });
    const meterFill = el('div', { class: 'meter-fill' });
    const meter = el('div', { class: 'meter' }, meterFill);
    const progressFill = el('div', { class: 'progress-fill' });
    const progress = el('div', { class: 'progress' }, progressFill);
    const detail = el('p', { class: 'hint', text: ' ' });
    const retry = el('button', { class: 'btn-primary', text: 'Try this step again' });
    retry.style.display = 'none';
    body.replaceChildren(title, instruction, meter, progress, detail, retry);

    const startStep = (): void => {
      elapsed = 0;
      collected.length = 0;
      const step = STEPS[stepIndex];
      title.textContent = step.title;
      instruction.textContent = step.instruction;
      retry.style.display = 'none';
      detail.textContent = ' ';
    };

    retry.addEventListener('click', startStep);

    const finishStep = (): void => {
      const step = STEPS[stepIndex];
      switch (step.id) {
        case 'silence':
          // A low percentile, not the mean: a cough or a passing car during the
          // quiet step shouldn't raise the floor for the whole session.
          measurements.noiseFloorDb = percentile(collected, 0.2);
          break;
        case 'loud':
          measurements.loudDb = percentile(collected, 0.7);
          break;
        case 'low':
          measurements.lowHz = percentile(collected, 0.5);
          break;
        case 'high':
          measurements.highHz = percentile(collected, 0.5);
          break;
      }

      stepIndex++;
      if (stepIndex < STEPS.length) {
        startStep();
        return;
      }
      complete(measurements);
    };

    startStep();

    return startLoop((dt) => {
      const frame = readFrame();
      const step = STEPS[stepIndex];
      elapsed += dt;

      meterFill.style.width = `${Math.round(Math.min(1, frame.level) * 100)}%`;

      if (elapsed < LEAD_IN) {
        detail.textContent = `Starting in ${Math.ceil(LEAD_IN - elapsed)}…`;
        return;
      }

      if (step.usable(frame, measurements.noiseFloorDb)) {
        collected.push(sampleFor(step, frame));
      }

      const gathered = collected.length * dt;
      progressFill.style.width = `${Math.round(Math.min(1, gathered / step.needed) * 100)}%`;
      detail.textContent = describe(step, frame);

      if (gathered >= step.needed) {
        finishStep();
      } else if (elapsed > step.timeout + LEAD_IN) {
        instruction.textContent =
          step.id === 'silence'
            ? 'Something went wrong reading the microphone.'
            : "Couldn't hear that clearly. Try getting a little closer to the microphone.";
        retry.style.display = '';
        elapsed = -Infinity; // Hold here until the retry button restarts the step.
      }
    });
  }

  function complete(measurements: {
    noiseFloorDb: number;
    loudDb: number;
    lowHz: number;
    highHz: number;
  }): void {
    stopRendering?.();
    stopRendering = null;

    // Humming the "highest" note lower than the "lowest" is an easy mistake and
    // a pointless thing to fail someone over.
    const lowest = Math.min(measurements.lowHz, measurements.highHz);
    const highest = Math.max(measurements.lowHz, measurements.highHz);
    const range = padPitchRange(lowest, highest);

    saveProfile({
      version: 1,
      noiseFloorDb: measurements.noiseFloorDb,
      loudDb: Math.max(measurements.loudDb, measurements.noiseFloorDb + 10),
      lowHz: range.lowHz,
      highHz: range.highHz,
      createdAt: Date.now(),
    });
    refreshProfile();

    const low = hzToNote(range.lowHz);
    const high = hzToNote(range.highHz);
    const play = el('button', { class: 'btn-primary', text: 'Play Hum Flyer' });
    play.addEventListener('click', () => navigate('hum-flyer'));
    const again = el('button', { text: 'Calibrate again' });
    again.addEventListener('click', () => window.location.reload());

    body.replaceChildren(
      el('h1', { text: 'Calibrated' }),
      el('p', {
        text: `Your range: ${low.name}${low.octave} to ${high.name}${high.octave}. Room noise floor ${Math.round(measurements.noiseFloorDb)} dB.`,
      }),
      play,
      again,
      el('p', {
        class: 'hint',
        text: 'Run this again if you switch device, room, or headphones.',
      }),
    );
  }

  return () => {
    disposed = true;
    stopRendering?.();
    stopSession();
    root.replaceChildren();
  };
}

function sampleFor(step: Step, frame: Frame): number {
  if (step.id === 'silence' || step.id === 'loud') return frame.db;
  return frame.pitchHz ?? 0;
}

function describe(step: Step, frame: Frame): string {
  if (step.id === 'silence') return `Room noise ${Math.round(frame.db)} dB`;
  if (step.id === 'loud') return `${Math.round(frame.db)} dB`;
  if (frame.pitchHz === null) return 'Listening for a hum…';
  const note = hzToNote(frame.pitchHz);
  return `${note.name}${note.octave} · ${Math.round(frame.pitchHz)} Hz`;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index];
}
