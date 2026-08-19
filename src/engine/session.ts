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

let session: Session | null = null;

export function currentSession(): Session | null {
  return session;
}

export async function ensureMicSession(): Promise<Session> {
  if (session && session.source.kind === 'mic') {
    await session.source.context.resume();
    refreshProfile();
    return session;
  }
  stopSession();
  const source = await createMicSource();
  session = { source, analyser: new Analyser(source) };
  refreshProfile();
  return session;
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
  if (!session) return;
  session.analyser.dispose();
  session.source.stop();
  session = null;
}
