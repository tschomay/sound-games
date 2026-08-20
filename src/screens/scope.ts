/**
 * Live view of every detector at once.
 *
 * Built before any game, deliberately: microphone input varies wildly between
 * devices and rooms, and you cannot tune a detector you cannot see. When a game
 * misreads someone, this is the screen that says why.
 */
import { stopSession, type Session } from '../engine/session';
import { hzToNote } from '../engine/pitch';
import { createSurface, startLoop } from '../engine/canvas';
import { el, readoutCell, topbar, type Cleanup } from '../ui';
import { sourceGate } from './source-picker';
import { transportBar, type TransportBar } from './transport-bar';
import { isFileSource } from '../engine/source';
import type { Analyser } from '../engine/analyser';
import type { BeatReading } from '../engine/beat';

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
    bpm: readoutCell('BPM'),
    beatConfidence: readoutCell('Beat confidence'),
  };
  const readout = el('div', { class: 'readout' }, ...Object.values(cells).map((c) => c.root));
  const transportSlot = el('div', {});

  root.appendChild(
    el('div', { class: 'screen' }, topbar('Signal scope'), stage, transportSlot, readout),
  );

  let stopRendering: (() => void) | null = null;
  let surface: ReturnType<typeof createSurface> | null = null;
  let transport: TransportBar | null = null;
  let disposed = false;

  const gate = sourceGate(
    'Watch the waveform, spectrum, and every detector live — from the microphone or a loaded file.',
    (session) => {
      if (disposed) return;
      gate.root.remove();
      begin(session);
    },
    { allowFile: true },
  );
  stage.appendChild(gate.root);

  function begin(session: Session): void {
    surface = createSurface(stage);
    if (isFileSource(session.source)) {
      session.source.play();
      transport = transportBar(session.source);
      transportSlot.appendChild(transport.root);
    }
    stopRendering = draw(session.analyser, surface);
  }

  function draw(analyser: Analyser, target: ReturnType<typeof createSurface>): () => void {
    const flux: number[] = [];
    let onsetCount = 0;
    let onsetFlash = 0;
    let gateFlash = 0;
    let beatPulse = 0;

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
      // Decays over ~1/3s — fast enough to read as a pulse tied to this
      // instant, slow enough to actually be seen at a normal frame rate.
      if (frame.beat.onBeat) beatPulse = 1;
      beatPulse = Math.max(0, beatPulse - dt * 3);

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

      // The actual "stable beat grid" visualisation Phase 6's done-when asks
      // for: a third colour again, and a shape (a sweeping ring plus a pulse)
      // rather than a binary flash, because `beatPhase` is continuous and a
      // human judges "locked on" by watching it sweep smoothly, not by a
      // single yes/no per beat.
      drawBeatPulse(ctx, frame.beat, beatPulse, width);

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
      cells.bpm.set(frame.beat.bpm !== null ? String(Math.round(frame.beat.bpm)) : '–');
      cells.beatConfidence.set(frame.beat.confidence.toFixed(2));
    });
  }

  return () => {
    disposed = true;
    gate.dispose();
    stopRendering?.();
    transport?.dispose();
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

const BEAT_COLOUR = '196, 132, 252'; // violet — distinct from onset green and gated red

/**
 * The beat pulse: a ring that sweeps continuously with `beatPhase` plus a
 * disc that snaps bright on the `onBeat` edge and decays.
 *
 * The sweep is the actual "is this locked on" signal — a human watching it
 * can tell a steady, evenly-paced rotation (locked to the music's actual
 * pulse) from one that jitters, stalls, or jumps (drifting or wrong) far more
 * easily than from a per-beat flash alone, which is why this is a continuous
 * shape and not just another flash like the two above. An empty outline with
 * no fill or disc is itself informative: `bpm: null` reads as "found
 * nothing", not as a broken screen.
 */
function drawBeatPulse(
  ctx: CanvasRenderingContext2D,
  beat: BeatReading,
  pulse: number,
  width: number,
): void {
  const cx = width - 46;
  const cy = 46;
  const radius = 26;

  ctx.save();
  ctx.translate(cx, cy);

  ctx.strokeStyle = `rgba(${BEAT_COLOUR}, 0.25)`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.stroke();

  if (beat.bpm !== null && beat.beatPhase !== null) {
    const start = -Math.PI / 2;
    const end = start + beat.beatPhase * Math.PI * 2;
    // Opacity tracks confidence, same "trust this less" convention the
    // readout cells use — a sweeping-but-dim ring means "found a tempo, but
    // don't believe it yet".
    ctx.strokeStyle = `rgba(${BEAT_COLOUR}, ${0.35 + beat.confidence * 0.65})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, radius, start, end);
    ctx.stroke();
  }

  if (pulse > 0) {
    ctx.fillStyle = `rgba(${BEAT_COLOUR}, ${pulse * 0.85})`;
    ctx.beginPath();
    ctx.arc(0, 0, radius * (0.35 + 0.25 * pulse), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
  label(ctx, 'beat', cx - 14, cy + radius + 16);
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.fillStyle = '#8fa3b8';
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(text, x, y);
}
