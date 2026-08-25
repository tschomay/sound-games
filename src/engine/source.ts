/**
 * Audio sources. See ADR-0001 — live mic and loaded file, one interface.
 */
import { PlaybackTransport } from './transport';
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

/**
 * Every audio-input device the browser currently knows about. Labels are
 * blank until mic permission has been granted at least once for this origin
 * — call after a successful `createMicSource()`.
 */
export async function listMicDevices(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === 'audioinput');
}

/**
 * Chrome on Android enumerates its audio *routes* as pseudo mic devices —
 * "Speakerphone", "Earpiece", "Wired Headset", "Bluetooth …" — rather than
 * physical hardware. Picking "Speakerphone" over whatever the OS defaults to
 * matters once a Bluetooth accessory is paired: Android's AudioManager hints
 * apps toward the accessory's mic as soon as one is available, and a mic
 * request with no explicit device follows that hint. That's what forces the
 * Bluetooth link into HFP — the low-quality, bidirectional call profile —
 * even though this app never wanted the accessory's mic, dragging down
 * whatever else is playing over the same link's high-quality A2DP profile.
 * "Earpiece", the other common default, is built for a handset held to the
 * ear anyway — narrow pickup, quiet at any distance a phone-on-a-surface
 * actually needs.
 *
 * No-op wherever the label doesn't exist: iOS and desktop browsers don't
 * expose these pseudo-devices, so `find` returns undefined and the caller
 * keeps whatever it already opened. A pure function so it's testable without
 * a real device list.
 */
export function pickSpeakerphoneDevice(devices: MediaDeviceInfo[]): MediaDeviceInfo | undefined {
  return devices.find((device) => /speakerphone/i.test(device.label));
}

/**
 * @param deviceId Explicit input device to open, from `listMicDevices()`.
 *   Omit to let the browser pick — in which case, once the resulting stream's
 *   labels are available, this steers onto the "Speakerphone" route if one is
 *   on offer (see `pickSpeakerphoneDevice`). Passing a deviceId explicitly
 *   (from a picker) is a deliberate choice and is never second-guessed here.
 *
 *   This mitigates only the part a web page can reach — which mic a request
 *   with no explicit device lands on. It does not stop a connected Bluetooth
 *   speaker's *output* dropping to call quality the instant any recording
 *   session opens, regardless of which mic that session uses: A2DP
 *   (high-quality, output-only) and HFP (call-quality, bidirectional) are
 *   competing profiles most Bluetooth accessories cannot run at once, and
 *   nothing exposed to web JS can opt a page out of that renegotiation the
 *   way a native app can. Steering off the accessory's own mic is still
 *   worth doing — it is the one thing a page *can* control, and it stops one
 *   specific self-inflicted case: this app dragging the link into HFP on its
 *   own even though it never wanted the accessory's mic in the first place.
 */
export async function createMicSource(deviceId?: string): Promise<AudioSource> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MicPermissionError(
      'This browser will not give a page microphone access. Note that microphone access needs a secure (https) connection.',
      'unsupported',
    );
  }

  let stream = await openMicStream(deviceId);

  if (deviceId === undefined) {
    const steered = await steerToSpeakerphone(stream).catch(() => null);
    if (steered) stream = steered;
  }

  const context = new AudioContext();
  await context.resume();
  const node = context.createMediaStreamSource(stream);

  return {
    kind: 'mic',
    label: stream.getAudioTracks()[0]?.label || 'Microphone',
    deviceId: stream.getAudioTracks()[0]?.getSettings().deviceId,
    context,
    node,
    stop() {
      for (const track of stream.getTracks()) track.stop();
      node.disconnect();
      void context.close();
    },
  };
}

async function openMicStream(deviceId: string | undefined): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        ...RAW_AUDIO_CONSTRAINTS,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
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
}

/**
 * Reopens `stream` on the "Speakerphone" pseudo-device if one is on offer and
 * the default stream didn't already land there. Returns null (keep `stream`
 * as-is) when there's nothing to steer onto, or when the reopen itself fails
 * — losing the steering is not worth losing the mic session over.
 */
async function steerToSpeakerphone(stream: MediaStream): Promise<MediaStream | null> {
  const devices = await listMicDevices();
  const speakerphone = pickSpeakerphoneDevice(devices);
  const activeId = stream.getAudioTracks()[0]?.getSettings().deviceId;
  if (!speakerphone || speakerphone.deviceId === activeId) return null;

  const steered = await navigator.mediaDevices.getUserMedia({
    audio: { ...RAW_AUDIO_CONSTRAINTS, deviceId: { exact: speakerphone.deviceId } },
  });
  for (const track of stream.getTracks()) track.stop();
  return steered;
}

export interface FileSource extends AudioSource {
  readonly kind: 'file';
  readonly buffer: AudioBuffer;
  /** With no offset, resumes from wherever `pause()` left it (0 if never started). */
  play(offsetSeconds?: number): void;
  /** Freeze playback in place. A no-op if already paused. */
  pause(): void;
  /** Jump to `offsetSeconds`. Keeps playing if it was playing, stays paused if not. */
  seek(offsetSeconds: number): void;
  /** Seconds into the track, or 0 before playback starts. */
  position(): number;
  playing(): boolean;
}

/** Narrows a generic `AudioSource` (e.g. `Session.source`) to `FileSource`. */
export function isFileSource(source: AudioSource): source is FileSource {
  return source.kind === 'file';
}

export async function createFileSource(file: File): Promise<FileSource> {
  const context = new AudioContext();
  await context.resume();
  const buffer = await context.decodeAudioData(await file.arrayBuffer());

  // A gain node gives analysis a stable tap point that survives the source node
  // being replaced on every play/seek.
  const output = context.createGain();
  output.connect(context.destination);

  // Bookkeeping (position, paused/playing) lives in `PlaybackTransport`,
  // testable with plain numbers; this factory's only job is turning its
  // decisions into an actual buffer source node. See `transport.ts`.
  const transport = new PlaybackTransport(buffer.duration);
  let node: AudioBufferSourceNode | null = null;

  function startNodeAt(offsetSeconds: number): void {
    node?.stop();
    node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(output);
    node.start(0, offsetSeconds);
  }

  const source: FileSource = {
    kind: 'file',
    label: file.name,
    context,
    node: output,
    buffer,
    play(offsetSeconds) {
      startNodeAt(transport.play(context.currentTime, offsetSeconds));
    },
    pause() {
      transport.pause(context.currentTime);
      node?.stop();
      node = null;
    },
    seek(offsetSeconds) {
      const at = transport.seek(context.currentTime, offsetSeconds);
      // Scrubbing while paused just moves the frozen marker; only a node that
      // was actually running needs to be torn down and restarted mid-jump.
      if (transport.playing) startNodeAt(at);
    },
    position() {
      return transport.position(context.currentTime);
    },
    playing() {
      return transport.playing && source.position() < buffer.duration;
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
