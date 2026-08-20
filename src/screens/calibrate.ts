/**
 * Calibration flow. See ADR-0003 for why games read a profile rather than raw
 * audio, and ADR-0004 for why this comes in two halves.
 *
 * Room first — noise floor and comfortable loudness — which every game needs and
 * which is saved the moment it's measured. Then the hum range, which only
 * voice-controlled games need, and which the player can skip.
 *
 * The same flow serves two entry points: the full run, and a voice-only run for
 * someone who skipped the hum test (or calibrated before it was optional) and
 * wants to add it without redoing the room.
 */
import { ensureMicSession, refreshProfile, stopSession } from '../engine/session';
import { loadProfile, padPitchRange, saveProfile } from '../engine/calibration';
import { hzToNote } from '../engine/pitch';
import { startLoop } from '../engine/canvas';
import { GAMES } from '../games/registry';
import { el, navigate, overlay, topbar, type Cleanup } from '../ui';
import type { CalibrationProfile, Frame, PitchRange } from '../engine/types';

interface Measurements {
  noiseFloorDb: number;
  loudDb: number;
  lowHz: number;
  highHz: number;
}

interface Step {
  id: keyof Measurements;
  title: string;
  instruction: string;
  /** Seconds of usable samples needed before the step is satisfied. */
  needed: number;
  /** Seconds before we give up and offer a retry. */
  timeout: number;
  usable(frame: Frame, measured: Measurements): boolean;
  /** Which percentile of the collected samples becomes the measurement. */
  percentile: number;
  sample(frame: Frame): number;
  describe(frame: Frame): string;
}

const ROOM_STEPS: Step[] = [
  {
    id: 'noiseFloorDb',
    title: 'Silence',
    instruction: 'Stay quiet for a moment so we can hear how noisy your room is.',
    needed: 2,
    timeout: 6,
    usable: () => true,
    // A low percentile, not the mean: a cough or a passing car during the quiet
    // step shouldn't raise the floor for the whole session.
    percentile: 0.2,
    sample: (frame) => frame.db,
    describe: (frame) => `Room noise ${Math.round(frame.db)} dB`,
  },
  {
    id: 'loudDb',
    title: 'Comfortable volume',
    instruction: 'Now make a steady sound — hum, sing, anything you could keep up for a whole game.',
    needed: 1.5,
    timeout: 12,
    usable: (frame, measured) => frame.db > measured.noiseFloorDb + 6,
    percentile: 0.7,
    sample: (frame) => frame.db,
    describe: (frame) => `${Math.round(frame.db)} dB`,
  },
];

const VOICE_STEPS: Step[] = [
  {
    id: 'lowHz',
    title: 'Your lowest note',
    instruction: 'Hum the lowest note you can hold comfortably.',
    needed: 1,
    timeout: 14,
    usable: (frame) => frame.voiced && frame.clarity > 0.9,
    percentile: 0.5,
    sample: (frame) => frame.pitchHz ?? 0,
    describe: describePitch,
  },
  {
    id: 'highHz',
    title: 'Your highest note',
    instruction: 'Now hum the highest note you can hold comfortably. No need to strain.',
    needed: 1,
    timeout: 14,
    usable: (frame) => frame.voiced && frame.clarity > 0.9,
    percentile: 0.5,
    sample: (frame) => frame.pitchHz ?? 0,
    describe: describePitch,
  },
];

/** A second of lead-in per step, so we're not recording the tap that started it. */
const LEAD_IN = 1;

export function calibrateScreen(root: HTMLElement): Cleanup {
  return calibrationFlow(root, 'full');
}

/**
 * Just the hum test, for a player who already has a room profile. Reached from
 * the menu, so adding voice control later doesn't mean sitting through the room
 * steps again.
 */
export function voiceSetupScreen(root: HTMLElement): Cleanup {
  const existing = loadProfile();
  if (!existing) {
    navigate('calibrate', { replace: true });
    return () => {};
  }
  return calibrationFlow(root, 'voice', existing);
}

type FlowMode = 'full' | 'voice';

function calibrationFlow(
  root: HTMLElement,
  mode: FlowMode,
  existing: CalibrationProfile | null = null,
): Cleanup {
  const stage = el('div', { class: 'stage' });
  const body = el('div', { class: 'stack' });
  stage.appendChild(body);
  const title = mode === 'voice' ? 'Voice setup' : 'Calibrate';
  root.appendChild(el('div', { class: 'screen screen--scroll' }, topbar(title), stage));

  // In voice mode the room is already measured; carry it through so saving the
  // new range doesn't clobber it.
  const measurements: Measurements = {
    noiseFloorDb: existing?.noiseFloorDb ?? -65,
    loudDb: existing?.loudDb ?? -22,
    lowHz: 110,
    highHz: 440,
  };

  let readFrame: (() => Frame) | null = null;
  let stopRendering: (() => void) | null = null;
  let disposed = false;

  const gate = overlay(
    mode === 'voice'
      ? 'Two short hums — your lowest comfortable note, then your highest. About ten seconds.'
      : 'First a few seconds of quiet, then one steady sound. That covers every game; voice games need a short hum test after that, which you can skip.',
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
      readFrame = session.analyser.read.bind(session.analyser);
      if (mode === 'voice') runPhase(VOICE_STEPS, finishVoice);
      else runPhase(ROOM_STEPS, finishRoom);
    } catch (error) {
      gate.showError(error instanceof Error ? error.message : 'Could not open the microphone.');
    }
  }

  /** Run a list of steps to completion, then hand back. */
  function runPhase(steps: Step[], onComplete: () => void): void {
    const read = readFrame;
    if (!read) return;

    let stepIndex = 0;
    let elapsed = 0;
    const collected: number[] = [];

    const title = el('h1', { text: steps[0].title });
    const instruction = el('p', { text: steps[0].instruction });
    const meterFill = el('div', { class: 'meter-fill' });
    const progressFill = el('div', { class: 'progress-fill' });
    const detail = el('p', { class: 'hint', text: ' ' });
    const retry = el('button', { class: 'btn-primary', text: 'Try this step again' });
    retry.style.display = 'none';
    body.replaceChildren(
      title,
      instruction,
      el('div', { class: 'meter' }, meterFill),
      el('div', { class: 'progress' }, progressFill),
      detail,
      retry,
    );

    const startStep = (): void => {
      elapsed = 0;
      collected.length = 0;
      title.textContent = steps[stepIndex].title;
      instruction.textContent = steps[stepIndex].instruction;
      retry.style.display = 'none';
      detail.textContent = ' ';
    };
    retry.addEventListener('click', startStep);
    startStep();

    stopRendering = startLoop((dt) => {
      const frame = read();
      const step = steps[stepIndex];
      elapsed += dt;

      meterFill.style.width = `${Math.round(Math.min(1, frame.level) * 100)}%`;

      if (elapsed < LEAD_IN) {
        detail.textContent = `Starting in ${Math.ceil(LEAD_IN - elapsed)}…`;
        return;
      }

      if (step.usable(frame, measurements)) collected.push(step.sample(frame));

      const gathered = collected.length * dt;
      progressFill.style.width = `${Math.round(Math.min(1, gathered / step.needed) * 100)}%`;
      detail.textContent = step.describe(frame);

      if (gathered >= step.needed) {
        measurements[step.id] = percentile(collected, step.percentile);
        stepIndex++;
        if (stepIndex < steps.length) {
          startStep();
          return;
        }
        stopRendering?.();
        stopRendering = null;
        onComplete();
      } else if (elapsed > step.timeout + LEAD_IN) {
        instruction.textContent =
          step.id === 'noiseFloorDb'
            ? 'Something went wrong reading the microphone.'
            : "Couldn't hear that clearly. Try getting a little closer to the microphone.";
        retry.style.display = '';
        elapsed = -Infinity; // Hold here until the retry button restarts the step.
      }
    });
  }

  /** Persist what's measured so far, keeping any pitch range already on file. */
  function persist(pitchRange: PitchRange | null): CalibrationProfile {
    const profile: CalibrationProfile = {
      version: 2,
      noiseFloorDb: measurements.noiseFloorDb,
      // A ceiling below the floor would make every sound read as full volume.
      loudDb: Math.max(measurements.loudDb, measurements.noiseFloorDb + 10),
      pitchRange,
      createdAt: Date.now(),
    };
    saveProfile(profile);
    refreshProfile();
    return profile;
  }

  function finishRoom(): void {
    // Saved before the choice, not after — walking away here should still leave
    // the room measured rather than throwing the work away.
    const existing = loadProfile()?.pitchRange ?? null;
    persist(existing);
    showChoice(existing);
  }

  function showChoice(existing: PitchRange | null): void {
    const start = el('button', {
      class: 'btn-primary',
      text: existing ? 'Redo the hum test' : 'Set up voice control',
    });
    start.addEventListener('click', () => runPhase(VOICE_STEPS, finishVoice));

    const skip = el('button', { text: existing ? 'Keep what I have' : 'Skip for now' });
    skip.addEventListener('click', () => showSummary(loadProfile()));

    body.replaceChildren(
      el('h1', { text: 'Room calibrated' }),
      el('p', {
        text: `Noise floor ${Math.round(measurements.noiseFloorDb)} dB. That's everything the music games need — they're unlocked now.`,
      }),
      el('p', {
        class: 'hint',
        text: 'Voice-controlled games also need your hum range: two more steps, about ten seconds.',
      }),
      start,
      skip,
    );
  }

  function finishVoice(): void {
    // Humming the "highest" note lower than the "lowest" is an easy mistake and
    // a pointless thing to fail someone over.
    const lowest = Math.min(measurements.lowHz, measurements.highHz);
    const highest = Math.max(measurements.lowHz, measurements.highHz);
    showSummary(persist(padPitchRange(lowest, highest)));
  }

  function showSummary(profile: CalibrationProfile | null): void {
    const range = profile?.pitchRange ?? null;
    const actions: HTMLElement[] = [];

    // Whichever voice game exists, rather than a hardcoded id — the registry is
    // there precisely so screens don't have to know game names.
    const unlocked = range ? GAMES.find((game) => game.requires === 'pitchRange') : undefined;
    if (unlocked) {
      const play = el('button', { class: 'btn-primary', text: `Play ${unlocked.title}` });
      play.addEventListener('click', () => navigate(unlocked.id));
      actions.push(play);
    } else if (!range) {
      const add = el('button', { class: 'btn-primary', text: 'Add voice control' });
      add.addEventListener('click', () => runPhase(VOICE_STEPS, finishVoice));
      actions.push(add);
    }

    const menu = el('button', { text: 'Back to games' });
    menu.addEventListener('click', () => navigate(''));
    const again = el('button', { text: 'Calibrate again' });
    again.addEventListener('click', () => window.location.reload());

    body.replaceChildren(
      el('h1', { text: 'Calibrated' }),
      el('p', { text: summaryText(profile, range) }),
      ...actions,
      menu,
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

function summaryText(profile: CalibrationProfile | null, range: PitchRange | null): string {
  const floor = Math.round(profile?.noiseFloorDb ?? 0);
  if (!range) {
    return `Room noise floor ${floor} dB. Voice control is not set up, so games that need your pitch are still locked.`;
  }
  const low = hzToNote(range.lowHz);
  const high = hzToNote(range.highHz);
  return `Your range: ${low.name}${low.octave} to ${high.name}${high.octave}. Room noise floor ${floor} dB.`;
}

function describePitch(frame: Frame): string {
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
