/**
 * One shared microphone session for the whole app. Getting a mic prompt on every
 * screen would be miserable, and browsers only hand out a stream from inside a
 * user gesture, so the session is opened once on a tap and kept alive.
 */
import { Analyser } from './analyser';
import { CausalBeatTracker } from './beat-causal';
import { BeatGridReader, type BeatGrid } from './beat-offline';
import { CausalBeatInput, FileBeatInput, type BeatInput } from './beat-input';
import { OutputBus } from './output';
import { createMicSource, isFileSource } from './source';
import { DEFAULT_PROFILE, loadProfile } from './calibration';
import type { AudioSource } from './types';

export interface Session {
  source: AudioSource;
  analyser: Analyser;
  /** Shares `source`'s AudioContext — one context per session, not two. */
  output: OutputBus;
}

/**
 * `beatGrid` is whatever `analyseBeatGrid` (`beat-offline.ts`) already
 * computed for a file source — this function never decodes or analyses audio
 * itself, only wires up a reader for a grid someone else already has. See
 * ADR-0011 for why that analysis happens in `source-picker.ts`, not here.
 * `null`/omitted means "no grid": either the source is the mic, or the file
 * had no findable beat, or nobody computed one — either way `Frame.beat` just
 * stays `NO_BEAT` for this session.
 */
function openSession(source: AudioSource, beatGrid: BeatGrid | null = null): Session {
  const output = new OutputBus(source.context);
  const beat = createBeatInput(source, beatGrid);
  return { source, analyser: new Analyser(source, { suppression: output, beat }), output };
}

function createBeatInput(source: AudioSource, beatGrid: BeatGrid | null): BeatInput | undefined {
  if (source.kind === 'mic') return new CausalBeatInput(new CausalBeatTracker());
  if (isFileSource(source) && beatGrid) {
    return new FileBeatInput(new BeatGridReader(beatGrid), () => source.position());
  }
  return undefined;
}

/** Thrown when a screen goes away while its microphone request was in flight. */
export class SessionAbandonedError extends Error {
  constructor() {
    super('The microphone request was abandoned.');
    this.name = 'SessionAbandonedError';
  }
}

let session: Session | null = null;
/** The in-flight request, so concurrent callers share one microphone. */
let pending: Promise<Session> | null = null;
/**
 * Bumped every time the session is torn down. A request that resolves after its
 * screen has gone compares this against the value it started with, and releases
 * the stream instead of leaving the recording indicator lit for nobody.
 */
let epoch = 0;

export function currentSession(): Session | null {
  return session;
}

export async function ensureMicSession(): Promise<Session> {
  if (session && session.source.kind === 'mic') {
    await session.source.context.resume();
    refreshProfile();
    return session;
  }
  if (session) stopSession(); // a file source was open; the caller wants the mic
  if (pending) return pending;

  const requestedAt = epoch;
  pending = (async () => {
    const source = await createMicSource();
    if (epoch !== requestedAt) {
      source.stop();
      throw new SessionAbandonedError();
    }
    session = openSession(source);
    refreshProfile();
    return session;
  })();
  // Clear the slot however it settles, so a failure doesn't wedge every later
  // attempt on the same rejected promise.
  void pending.catch(() => {}).finally(() => {
    pending = null;
  });
  return pending;
}

/** @param beatGrid see `openSession`'s doc comment. */
export function useSource(source: AudioSource, beatGrid: BeatGrid | null = null): Session {
  stopSession();
  session = openSession(source, beatGrid);
  refreshProfile();
  return session;
}

/** Pick up a profile written since the session opened. */
export function refreshProfile(): void {
  if (session) session.analyser.profile = loadProfile() ?? DEFAULT_PROFILE;
}

export function stopSession(): void {
  epoch++;
  if (!session) return;
  session.analyser.dispose();
  session.output.dispose();
  session.source.stop();
  session = null;
}
