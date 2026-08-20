/**
 * Live view of every detector at once.
 *
 * Built before any game, deliberately: microphone input varies wildly between
 * devices and rooms, and you cannot tune a detector you cannot see. When a game
 * misreads someone, this is the screen that says why.
 */
import { ensureMicSession, stopSession } from '../engine/session';
import { hzToNote } from '../engine/pitch';
import { createSurface, startLoop } from '../engine/canvas';
import { el, overlay, readoutCell, topbar, type Cleanup } from '../ui';
import type { Analyser } from '../engine/analyser';

const FLUX_HISTORY = 200;

export function scopeScreen(root: HTMLElement): Cleanup {
  const stage = el('div', { class: 'stage' });

  const cells = {
    level: readoutCell('Level'),
    db: readoutCell('dBFS'),
    pitch: readoutCell('Pitch'),
    note: readoutCell('Note'),
    clarity: readoutCell('Clarity'),
    centroid: readoutCell('Centroid'),
    flatness: readoutCell('Flatness'),
    zcr: readoutCell('ZCR'),
    timbreClass: readoutCell('Timbre class'),
    onsets: readoutCell('Onsets'),
    gated: readoutCell('Gated'),
  };
  const readout = el('div', { class: 'readout' }, ...Object.values(cells).map((c) => c.root));

  root.appendChild(el('div', { class: 'screen' }, topbar('Signal scope'), stage, readout));

  let stopRendering: (() => void) | null = null;
  let surface: ReturnType<typeof createSurface> | null = null;
  let disposed = false;

  const gate = overlay(
    'Watch the microphone signal live: waveform, spectrum, and every detector.',
    'Open microphone',
    () => void begin(),
  );
  stage.appendChild(gate.root);

  async function begin(): Promise<void> {
    gate.setBusy(true);
    try {
      const session = await ensureMicSession();
      if (disposed) return;
      gate.root.remove();
      surface = createSurface(stage);
      stopRendering = draw(session.analyser, surface);
    } catch (error) {
      gate.showError(error instanceof Error ? error.message : 'Could not open the microphone.');
    }
  }

  function draw(analyser: Analyser, target: ReturnType<typeof createSurface>): () => void {
    const flux: number[] = [];
    let onsetCount = 0;
    let onsetFlash = 0;
    let gateFlash = 0;

    return startLoop((dt) => {
      const frame = analyser.read();
      const { ctx, width, height } = target;

      if (frame.onset) {
        onsetCount++;
        onsetFlash = 1;
      }
      onsetFlash = Math.max(0, onsetFlash - dt * 4);
      if (frame.gated) gateFlash = 1;
      gateFlash = Math.max(0, gateFlash - dt * 4);

      flux.push(frame.flux);
      if (flux.length > FLUX_HISTORY) flux.shift();

      ctx.clearRect(0, 0, width, height);
      const paneHeight = height / 3;

      drawWaveform(ctx, analyser.waveformView(), width, paneHeight);
      drawSpectrum(ctx, analyser.spectrumView(), width, paneHeight, paneHeight);
      drawFlux(ctx, flux, width, paneHeight, paneHeight * 2);

      if (onsetFlash > 0) {
        ctx.fillStyle = `rgba(74, 222, 128, ${onsetFlash * 0.18})`;
        ctx.fillRect(0, 0, width, height);
      }
      // A distinct colour from the onset flash: this one means "the analyser
      // is deliberately ignoring what it just heard", not "it heard a clap".
      if (gateFlash > 0) {
        ctx.fillStyle = `rgba(248, 113, 113, ${gateFlash * 0.22})`;
        ctx.fillRect(0, 0, width, height);
      }

      cells.level.set(frame.level.toFixed(2));
      cells.db.set(`${Math.round(frame.db)}`);
      cells.pitch.set(frame.pitchHz ? `${Math.round(frame.pitchHz)} Hz` : '–');
      cells.note.set(noteLabel(frame.pitchHz));
      cells.clarity.set(frame.clarity.toFixed(2));
      cells.centroid.set(`${Math.round(frame.centroid)}`);
      cells.flatness.set(frame.flatness.toFixed(3));
      cells.zcr.set(frame.zcr.toFixed(3));
      cells.timbreClass.set(frame.timbreClass);
      cells.onsets.set(String(onsetCount));
      cells.gated.set(frame.gated ? 'yes' : 'no');
    });
  }

  return () => {
    disposed = true;
    stopRendering?.();
    surface?.dispose();
    stopSession();
    root.replaceChildren();
  };
}

function noteLabel(hz: number | null): string {
  if (hz === null) return '–';
  const note = hzToNote(hz);
  const sign = note.cents >= 0 ? '+' : '';
  return `${note.name}${note.octave} ${sign}${note.cents}`;
}

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  samples: Float32Array,
  width: number,
  height: number,
): void {
  ctx.save();
  ctx.strokeStyle = '#4ade80';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const step = Math.max(1, Math.floor(samples.length / width));
  for (let x = 0, i = 0; i < samples.length; i += step, x++) {
    const y = height / 2 - samples[i] * (height / 2) * 0.9;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  label(ctx, 'waveform', 6, 14);
  ctx.restore();
}

function drawSpectrum(
  ctx: CanvasRenderingContext2D,
  spectrum: Float32Array,
  width: number,
  height: number,
  top: number,
): void {
  ctx.save();
  ctx.translate(0, top);
  ctx.fillStyle = '#38bdf8';
  // Log frequency axis: a linear one wastes most of the screen on the top two
  // octaves, where almost nothing we care about lives.
  const bins = spectrum.length;
  for (let x = 0; x < width; x++) {
    const bin = Math.min(bins - 1, Math.floor(Math.pow(bins, x / width)));
    const magnitude = Math.max(0, (spectrum[bin] + 100) / 100);
    const barHeight = magnitude * height * 0.9;
    ctx.fillRect(x, height - barHeight, 1, barHeight);
  }
  label(ctx, 'spectrum (log f)', 6, 14);
  ctx.restore();
}

function drawFlux(
  ctx: CanvasRenderingContext2D,
  flux: number[],
  width: number,
  height: number,
  top: number,
): void {
  ctx.save();
  ctx.translate(0, top);
  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const scale = height / 8;
  for (let i = 0; i < flux.length; i++) {
    const x = (i / FLUX_HISTORY) * width;
    const y = height - Math.min(height, flux[i] * scale);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  label(ctx, 'spectral flux', 6, 14);
  ctx.restore();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.fillStyle = '#8fa3b8';
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(text, x, y);
}
