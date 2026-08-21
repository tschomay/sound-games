/**
 * Per-device latency measurement, on its own — reachable any time from the
 * menu's setup panel, independent of room/voice calibration, because it
 * measures something about the *device* rather than the player. See
 * `engine/latency.ts` for the loopback mechanism and ADR-0015 for why this is
 * optional and skippable rather than a mandatory calibration step: not every
 * device or room can complete a clean loopback measurement, and both
 * beat-driven games play fine at the safe default of no compensation (0ms).
 *
 * Needs a room profile to already exist — there is nowhere sensible to attach
 * a latency number without one — so, like `voiceSetupScreen`, an uncalibrated
 * visitor is sent to the room flow first rather than shown a screen that has
 * nothing to save into.
 */
import { ensureMicSession, refreshProfile, stopSession, type Session } from '../engine/session';
import { loadProfile, saveProfile } from '../engine/calibration';
import { createClickBuffer, LoopbackLatencyMeasurement } from '../engine/latency';
import { OnsetDetector } from '../engine/onset';
import { startLoop } from '../engine/canvas';
import { el, navigate, overlay, topbar, type Cleanup } from '../ui';
import type { CalibrationProfile } from '../engine/types';

export function latencySetupScreen(root: HTMLElement): Cleanup {
  const existingProfile = loadProfile();
  if (!existingProfile) {
    navigate('calibrate', { replace: true });
    return () => {};
  }
  // TS doesn't carry the narrowing above into the closures below, but this
  // binding is genuinely never null past this point.
  const existing: CalibrationProfile = existingProfile;

  const stage = el('div', { class: 'stage' });
  const body = el('div', { class: 'stack' });
  stage.appendChild(body);
  root.appendChild(
    el('div', { class: 'screen screen--scroll' }, topbar('Device latency'), stage),
  );

  let disposed = false;
  let stopMeasuring: (() => void) | null = null;

  const gate = overlay(
    "A few quiet clicks will play through your speaker; we time how long your " +
      'microphone takes to hear each one. Stay near the mic and quiet while it runs — ' +
      "it's over in a few seconds either way.",
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
      runMeasurement(session);
    } catch (error) {
      gate.showError(error instanceof Error ? error.message : 'Could not open the microphone.');
    }
  }

  function runMeasurement(session: Session): void {
    const context = session.source.context;
    const buffer = createClickBuffer(context);
    const detector = new OnsetDetector(
      session.analyser.node.frequencyBinCount,
      context.sampleRate / 2,
    );
    const measurement = new LoopbackLatencyMeasurement(session.output, buffer, detector);

    const title = el('h1', { text: 'Measuring…' });
    const progressFill = el('div', { class: 'progress-fill' });
    const detail = el('p', { class: 'hint', text: 'Starting…' });
    const skip = el('button', { text: 'Skip' });
    body.replaceChildren(
      title,
      el('div', { class: 'progress' }, progressFill),
      detail,
      skip,
    );

    skip.addEventListener('click', () => {
      stopMeasuring?.();
      stopMeasuring = null;
      finish(null);
    });

    stopMeasuring = startLoop(() => {
      session.analyser.read();
      measurement.step(context.currentTime, session.analyser.spectrumView());
      const { trialsRun, trials, samples } = measurement.progress;
      progressFill.style.width = `${Math.round((trialsRun / Math.max(1, trials)) * 100)}%`;
      detail.textContent = `${samples} of ${trials} clicks heard clearly so far…`;
      if (measurement.finished) {
        stopMeasuring?.();
        stopMeasuring = null;
        finish(measurement.result);
      }
    });
  }

  function finish(latencySeconds: number | null): void {
    const before: CalibrationProfile = loadProfile() ?? existing;
    const measuredMs = latencySeconds !== null ? Math.round(latencySeconds * 1000) : null;
    // A failed/skipped attempt keeps whatever was already measured rather
    // than silently resetting a good number back to "none".
    const profile: CalibrationProfile = { ...before, deviceLatencyMs: measuredMs ?? before.deviceLatencyMs };
    saveProfile(profile);
    refreshProfile();

    const done = el('button', { class: 'btn-primary', text: 'Back to games' });
    done.addEventListener('click', () => navigate(''));
    body.replaceChildren(
      el('h1', { text: measuredMs !== null ? 'Latency measured' : "Didn't get a clean read" }),
      el('p', {
        text:
          measuredMs !== null
            ? `About ${measuredMs}ms between a scheduled sound and your microphone hearing it. ` +
              'Rhythm-Gated Combat and Drop Siege will judge your taps against that from now on.'
            : 'No compensation will be applied — the safe default. Both beat games still work fine without it; ' +
              'try again anytime from the menu.',
      }),
      done,
    );
  }

  return () => {
    disposed = true;
    stopMeasuring?.();
    stopSession();
    root.replaceChildren();
  };
}
