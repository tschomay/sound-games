/**
 * Audio sources. See ADR-0001 — live mic and loaded file, one interface.
 */
import type { AudioSource } from './types';

/**
 * The browser's voice-call DSP is actively hostile to what we're doing: echo
 * cancellation removes music coming from the room, noise suppression eats
 * sustained hums as "noise", and auto gain flattens exactly the dynamics we
 * want to read. All three off, always.
 */
const RAW_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

export class MicPermissionError extends Error {
  constructor(message: string, readonly reason: 'denied' | 'missing' | 'unsupported') {
    super(message);
    this.name = 'MicPermissionError';
  }
}

export async function createMicSource(): Promise<AudioSource> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MicPermissionError(
      'This browser will not give a page microphone access. Note that microphone access needs a secure (https) connection.',
      'unsupported',
    );
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO_CONSTRAINTS });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new MicPermissionError(
        'Microphone access was blocked. Allow it in your browser settings and try again.',
        'denied',
      );
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new MicPermissionError('No microphone was found on this device.', 'missing');
    }
    throw error;
  }

  const context = new AudioContext();
  await context.resume();
  const node = context.createMediaStreamSource(stream);

  return {
    kind: 'mic',
    label: stream.getAudioTracks()[0]?.label || 'Microphone',
    context,
    node,
    stop() {
      for (const track of stream.getTracks()) track.stop();
      node.disconnect();
      void context.close();
    },
  };
}

export interface FileSource extends AudioSource {
  readonly kind: 'file';
  readonly buffer: AudioBuffer;
  play(offsetSeconds?: number): void;
  /** Seconds into the track, or 0 before playback starts. */
  position(): number;
  playing(): boolean;
}

export async function createFileSource(file: File): Promise<FileSource> {
  const context = new AudioContext();
  await context.resume();
  const buffer = await context.decodeAudioData(await file.arrayBuffer());

  // A gain node gives analysis a stable tap point that survives the source node
  // being replaced on every play/seek.
  const output = context.createGain();
  output.connect(context.destination);

  let node: AudioBufferSourceNode | null = null;
  let startedAt = 0;
  let startOffset = 0;

  const source: FileSource = {
    kind: 'file',
    label: file.name,
    context,
    node: output,
    buffer,
    play(offsetSeconds = 0) {
      node?.stop();
      node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(output);
      node.start(0, offsetSeconds);
      startedAt = context.currentTime;
      startOffset = offsetSeconds;
    },
    position() {
      if (!node) return 0;
      return Math.min(buffer.duration, startOffset + (context.currentTime - startedAt));
    },
    playing() {
      return node !== null && source.position() < buffer.duration;
    },
    stop() {
      node?.stop();
      node = null;
      output.disconnect();
      void context.close();
    },
  };
  return source;
}
