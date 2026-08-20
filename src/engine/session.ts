/**
 * One shared microphone session for the whole app. Getting a mic prompt on every
 * screen would be miserable, and browsers only hand out a stream from inside a
 * user gesture, so the session is opened once on a tap and kept alive.
 */
import { Analyser } from './analyser';
import { createMicSource } from './source';
import { DEFAULT_PROFILE, loadProfile } from './calibration';
import type { AudioSource } from './types';

export interface Session {
  source: AudioSource;
  analyser: Analyser;
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
    session = { source, analyser: new Analyser(source) };
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

export function useSource(source: AudioSource): Session {
  stopSession();
  session = { source, analyser: new Analyser(source) };
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
  session.source.stop();
  session = null;
}
