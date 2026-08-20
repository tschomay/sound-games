import { describe, expect, it } from 'vitest';
import { PlaybackTransport } from '../transport';

describe('PlaybackTransport', () => {
  it('starts paused at position 0', () => {
    const t = new PlaybackTransport(10);
    expect(t.playing).toBe(false);
    expect(t.position(0)).toBe(0);
  });

  it('advances position with the clock once playing', () => {
    const t = new PlaybackTransport(10);
    t.play(0);
    expect(t.playing).toBe(true);
    expect(t.position(3)).toBe(3);
  });

  it('play with an explicit offset starts from there', () => {
    const t = new PlaybackTransport(10);
    t.play(0, 4);
    expect(t.position(1)).toBeCloseTo(5);
  });

  it('clamps position to the track duration', () => {
    const t = new PlaybackTransport(10);
    t.play(0);
    expect(t.position(50)).toBe(10);
  });

  it('pause freezes the position and stops it advancing', () => {
    const t = new PlaybackTransport(10);
    t.play(0);
    t.pause(3);
    expect(t.playing).toBe(false);
    expect(t.position(3)).toBe(3);
    expect(t.position(99)).toBe(3); // clock moving on doesn't move a paused position
  });

  it('pausing twice is a no-op, not a re-freeze at the later time', () => {
    const t = new PlaybackTransport(10);
    t.play(0);
    t.pause(3);
    t.pause(7); // already paused; must not overwrite the frozen position
    expect(t.position(99)).toBe(3);
  });

  it('play with no offset resumes from the paused position', () => {
    const t = new PlaybackTransport(10);
    t.play(0);
    t.pause(3);
    const at = t.play(20);
    expect(at).toBe(3);
    expect(t.playing).toBe(true);
    expect(t.position(21)).toBeCloseTo(4);
  });

  it('seek while paused updates the frozen position without starting playback', () => {
    const t = new PlaybackTransport(10);
    t.seek(0, 6);
    expect(t.playing).toBe(false);
    expect(t.position(50)).toBe(6);
  });

  it('seek while playing jumps and keeps advancing from the new spot', () => {
    const t = new PlaybackTransport(10);
    t.play(0);
    t.seek(2, 8); // 2s in, jump to the 8s mark
    expect(t.playing).toBe(true);
    expect(t.position(3)).toBeCloseTo(9); // one more second elapses from the jump
  });

  it('seek clamps into range', () => {
    const t = new PlaybackTransport(10);
    expect(t.seek(0, -5)).toBe(0);
    expect(t.seek(0, 999)).toBe(10);
  });
});
