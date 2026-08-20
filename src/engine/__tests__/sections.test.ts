/**
 * Section-detection tests.
 *
 * Every track below is synthetic, and the honest framing matters as much here as
 * it did for the beat tracker (ADR-0010). A `structuredTrack` segment is
 * *stationary* — the same tones, bass and hiss from its first sample to its
 * last — so the only changes of character in the whole file are the ones at the
 * joins, and those joins are instantaneous. Real music is not like that: its
 * sections breathe, its boundaries are crossfaded or anticipated by a fill, and
 * its verse and chorus differ by far less than any two segments here.
 *
 * So what these tests establish is that the algorithm *works as specified* —
 * that the checkerboard novelty finds a change where a change was put, that a
 * brief loud event is not mistaken for one, that the loudest stretch is named as
 * the drop, and that material with no structure produces no boundaries. What they
 * cannot establish is any accuracy figure on real music. **Nothing here has heard
 * a song.** See ADR-0013 for where this is expected to struggle.
 */
import { describe, expect, it } from 'vitest';
import { analyseBeatGrid } from '../beat-offline';
import { analyseSongStructure, type SongStructure } from '../sections';
import {
  noiseAudio,
  silentAudio,
  structuredTrack,
  toneAudio,
  type SegmentSpec,
} from './synthetic-audio';

/**
 * A four-part track: quiet intro, fuller verse, loud bass-heavy climax, quiet
 * outro. Boundaries at 16s, 32s and 46s.
 */
const FOUR_PART: SegmentSpec[] = [
  { seconds: 16, tones: [440, 880], amplitude: 0.08, noise: 0.005 },
  {
    seconds: 16,
    tones: [220, 440, 660],
    amplitude: 0.2,
    bassHz: 55,
    bassAmplitude: 0.15,
    noise: 0.02,
  },
  { seconds: 14, tones: [110, 220], amplitude: 0.35, bassHz: 45, bassAmplitude: 0.6, noise: 0.08 },
  { seconds: 14, tones: [330], amplitude: 0.06, noise: 0.005 },
];

/**
 * How far a detected boundary may be from the true one, in seconds.
 *
 * A boundary is snapped to a feature frame, which is one beat wide — 0.5s at 120
 * BPM, and up to a second at the bottom of the tempo range — and the frames are
 * smoothed over their neighbours before the kernel sees them, which can pull a
 * boundary a further frame either way. One second is therefore about two frames
 * on these tracks: tight enough that a boundary landing in the wrong section
 * would fail, loose enough not to be a test of floating-point luck. Sub-frame
 * interpolation was deliberately not done — see ADR-0013, boundaries landing
 * exactly on beat instants is worth more to a game than a tenth of a second.
 */
const BOUNDARY_TOLERANCE = 1;

/** The internal boundaries of a structure, i.e. every section start but the first. */
function boundariesOf(structure: SongStructure): number[] {
  return structure.sections.slice(1).map((section) => section.startSeconds);
}

/** Largest distance from a true boundary to the nearest detected one. */
function worstBoundaryError(structure: SongStructure, truth: number[]): number {
  const found = boundariesOf(structure);
  let worst = 0;
  for (const time of truth) {
    let nearest = Infinity;
    for (const boundary of found) nearest = Math.min(nearest, Math.abs(boundary - time));
    worst = Math.max(worst, nearest);
  }
  return worst;
}

describe('analyseSongStructure', () => {
  it('finds the joins of a four-part track and names the loudest part as the drop', () => {
    const track = structuredTrack({ bpm: 120, segments: FOUR_PART });
    const structure = analyseSongStructure(track.audio);

    expect(structure.sections).toHaveLength(4);
    expect(worstBoundaryError(structure, track.boundaries)).toBeLessThan(BOUNDARY_TOLERANCE);
    expect(structure.dropIndex).toBe(2);
    expect(structure.sections[2].isDrop).toBe(true);
    expect(structure.sections.filter((section) => section.isDrop)).toHaveLength(1);
  });

  it('reports intensity relative to the track, with the drop at 1 and the quietest at 0', () => {
    const track = structuredTrack({ bpm: 120, segments: FOUR_PART });
    const { sections, dropIndex } = analyseSongStructure(track.audio);

    expect(sections[dropIndex as number].intensity).toBe(1);
    expect(Math.min(...sections.map((section) => section.intensity))).toBe(0);
    for (const section of sections) {
      expect(section.intensity).toBeGreaterThanOrEqual(0);
      expect(section.intensity).toBeLessThanOrEqual(1);
    }
    // The intro is quiet, the drop is not, and both are below full scale.
    expect(sections[0].loudnessDb).toBeLessThan(sections[2].loudnessDb - 10);
    expect(sections[2].loudnessDb).toBeLessThan(0);
  });

  it('returns sections that tile the whole track with no gaps or overlaps', () => {
    const track = structuredTrack({ bpm: 120, segments: FOUR_PART });
    const structure = analyseSongStructure(track.audio);

    expect(structure.sections[0].startSeconds).toBe(0);
    expect(structure.sections[structure.sections.length - 1].endSeconds).toBeCloseTo(
      structure.duration,
      6,
    );
    for (let i = 1; i < structure.sections.length; i++) {
      expect(structure.sections[i].startSeconds).toBe(structure.sections[i - 1].endSeconds);
      expect(structure.sections[i].index).toBe(i);
      expect(structure.sections[i].durationSeconds).toBeCloseTo(
        structure.sections[i].endSeconds - structure.sections[i].startSeconds,
        6,
      );
    }
  });

  it('places every boundary exactly on a beat when it has a grid to work from', () => {
    const track = structuredTrack({ bpm: 120, segments: FOUR_PART });
    const structure = analyseSongStructure(track.audio);
    const grid = structure.grid;

    expect(structure.beatSynchronous).toBe(true);
    expect(grid).not.toBeNull();
    for (const section of structure.sections.slice(1)) {
      // Exactly, not approximately: the feature frames *are* the beats, so this is
      // the property a game can schedule a boss wave against.
      expect(grid?.beats[section.startBeat as number]).toBeCloseTo(section.startSeconds, 6);
    }
    // Beat counts agree with the beat positions they were derived from.
    for (const section of structure.sections) {
      expect(section.beatCount).toBeGreaterThan(0);
      expect(section.durationSeconds / (grid as { period: number }).period).toBeCloseTo(
        section.beatCount as number,
        0,
      );
    }
  });

  it('reuses a grid it is handed rather than analysing the file twice', () => {
    const track = structuredTrack({ bpm: 120, segments: FOUR_PART });
    const grid = analyseBeatGrid(track.audio);
    const supplied = analyseSongStructure(track.audio, { grid });

    expect(supplied.grid).toBe(grid);
    expect(boundariesOf(supplied)).toEqual(boundariesOf(analyseSongStructure(track.audio)));
  });

  it('falls back to a fixed time grid when the track has no beat at all', () => {
    // The same four parts with no click track over them: nothing periodic for
    // `analyseBeatGrid` to lock to, so the features are sampled on a half-second
    // ruler instead.
    const track = structuredTrack({ segments: FOUR_PART });
    const structure = analyseSongStructure(track.audio);

    expect(structure.beatSynchronous).toBe(false);
    expect(structure.grid).toBeNull();
    expect(structure.sections).toHaveLength(4);
    expect(worstBoundaryError(structure, track.boundaries)).toBeLessThan(BOUNDARY_TOLERANCE);
    expect(structure.dropIndex).toBe(2);
    for (const section of structure.sections) {
      expect(section.startBeat).toBeNull();
      expect(section.beatCount).toBeNull();
    }
  });

  it('can be forced onto the fixed grid even when a beat is available', () => {
    const track = structuredTrack({ bpm: 120, segments: FOUR_PART });
    const structure = analyseSongStructure(track.audio, { grid: null });

    expect(structure.beatSynchronous).toBe(false);
    expect(worstBoundaryError(structure, track.boundaries)).toBeLessThan(BOUNDARY_TOLERANCE);
  });

  it('finds the classic drop shape: a long quiet build and a sudden loud climax', () => {
    const track = structuredTrack({
      bpm: 128,
      segments: [
        { seconds: 30, tones: [330, 550], amplitude: 0.05, noise: 0.004 },
        { seconds: 25, tones: [330, 550, 770], amplitude: 0.1, noise: 0.01 },
        {
          seconds: 20,
          tones: [110, 220, 440],
          amplitude: 0.4,
          bassHz: 50,
          bassAmplitude: 0.7,
          noise: 0.1,
        },
        { seconds: 10, tones: [330], amplitude: 0.04, noise: 0.004 },
      ],
    });
    const structure = analyseSongStructure(track.audio);
    const drop = structure.sections[structure.dropIndex as number];

    expect(structure.dropIndex).not.toBeNull();
    expect(Math.abs(drop.startSeconds - 55)).toBeLessThan(BOUNDARY_TOLERANCE);
    expect(Math.abs(drop.endSeconds - 75)).toBeLessThan(BOUNDARY_TOLERANCE);
    // The build either side of it is nowhere near as intense.
    for (const section of structure.sections) {
      if (section.isDrop) continue;
      expect(section.intensity).toBeLessThan(0.5);
    }
  });

  it('finds the same joins across the tempo range and at other sample rates', () => {
    // The kernel is sized in seconds and the features are sampled in beats, so
    // the two have to be reconciled per track. This is the check that nothing was
    // quietly tuned to 120 BPM at 44.1kHz.
    for (const bpm of [70, 92, 120, 174]) {
      for (const seed of [1, 5, 42]) {
        const track = structuredTrack({ bpm, seed, segments: FOUR_PART });
        const structure = analyseSongStructure(track.audio);
        expect(structure.sections).toHaveLength(4);
        expect(worstBoundaryError(structure, track.boundaries)).toBeLessThan(BOUNDARY_TOLERANCE);
        expect(structure.dropIndex).toBe(2);
      }
    }
    for (const sampleRate of [22050, 48000]) {
      const track = structuredTrack({ bpm: 120, sampleRate, segments: FOUR_PART });
      const structure = analyseSongStructure(track.audio);
      expect(worstBoundaryError(structure, track.boundaries)).toBeLessThan(BOUNDARY_TOLERANCE);
      expect(structure.dropIndex).toBe(2);
    }
  });

  it('handles five segments as readily as four', () => {
    const track = structuredTrack({
      bpm: 140,
      segments: [
        { seconds: 15, tones: [440, 880], amplitude: 0.07, noise: 0.005 },
        {
          seconds: 15,
          tones: [220, 330],
          amplitude: 0.18,
          bassHz: 60,
          bassAmplitude: 0.12,
          noise: 0.02,
        },
        {
          seconds: 15,
          tones: [110, 220],
          amplitude: 0.4,
          bassHz: 45,
          bassAmplitude: 0.6,
          noise: 0.09,
        },
        {
          seconds: 15,
          tones: [220, 660],
          amplitude: 0.15,
          bassHz: 70,
          bassAmplitude: 0.1,
          noise: 0.015,
        },
        { seconds: 15, tones: [330, 990], amplitude: 0.06, noise: 0.004 },
      ],
    });
    const structure = analyseSongStructure(track.audio);

    expect(structure.sections).toHaveLength(5);
    expect(worstBoundaryError(structure, track.boundaries)).toBeLessThan(BOUNDARY_TOLERANCE);
    expect(structure.dropIndex).toBe(2);
  });

  it('is not fooled by a single loud fill in the middle of unchanging music', () => {
    // The false positive this module would otherwise be full of. The novelty
    // curve peaks at the fill — correctly, the next second really is unlike the
    // last — and the boundary is then vetoed because the music on either side of
    // it is the same music.
    const body = (seconds: number): SegmentSpec => ({
      seconds,
      tones: [220, 440],
      amplitude: 0.15,
      bassHz: 55,
      bassAmplitude: 0.12,
      noise: 0.02,
    });
    for (const fillSeconds of [1, 2]) {
      const track = structuredTrack({
        bpm: 120,
        segments: [
          body(30),
          {
            seconds: fillSeconds,
            tones: [110, 220],
            amplitude: 0.5,
            bassHz: 45,
            bassAmplitude: 0.8,
            noise: 0.15,
          },
          body(30 - fillSeconds),
        ],
      });
      const structure = analyseSongStructure(track.audio);
      expect(structure.sections).toHaveLength(1);
      expect(structure.dropIndex).toBeNull();
    }
  });

  it('reports no drop when no section stands out from the rest', () => {
    // Three sections that differ in *timbre* but not in intensity. The boundaries
    // are real and should be found; calling one of them the drop would be an
    // invention, so `dropIndex` is null and a game is left to decide for itself.
    const track = structuredTrack({
      bpm: 110,
      segments: [
        { seconds: 20, tones: [300, 600], amplitude: 0.2, noise: 0.01 },
        { seconds: 20, tones: [900, 1800], amplitude: 0.2, noise: 0.01 },
        { seconds: 20, tones: [500, 1000], amplitude: 0.2, noise: 0.01 },
      ],
    });
    const structure = analyseSongStructure(track.audio);

    expect(structure.sections.length).toBeGreaterThan(1);
    expect(structure.dropIndex).toBeNull();
    expect(structure.sections.every((section) => !section.isDrop)).toBe(true);
  });

  it('honours a minimum section length', () => {
    const track = structuredTrack({ bpm: 120, segments: FOUR_PART });
    const structure = analyseSongStructure(track.audio, { minSectionSeconds: 25 });

    for (const section of structure.sections) {
      expect(section.durationSeconds).toBeGreaterThanOrEqual(25 - BOUNDARY_TOLERANCE);
    }
  });

  it('rates its own confidence, and rates it at zero when it found nothing', () => {
    const track = structuredTrack({ bpm: 120, segments: FOUR_PART });
    const structure = analyseSongStructure(track.audio);

    expect(structure.confidence).toBeGreaterThan(0.5);
    expect(structure.sections[0].boundaryStrength).toBe(0);
    for (const section of structure.sections.slice(1)) {
      expect(section.boundaryStrength).toBeGreaterThan(0);
    }
    expect(analyseSongStructure(noiseAudio(60)).confidence).toBe(0);
  });
});

describe('analyseSongStructure with nothing to say', () => {
  it('reports one section for material with no structure in it', () => {
    // Uniform noise, an unchanging tone and silence all have exactly one section:
    // the whole track. Inventing boundaries in these is the failure mode that
    // matters most, because a game would build a wave schedule out of them.
    for (const audio of [noiseAudio(60), toneAudio(60), silentAudio(60)]) {
      const structure = analyseSongStructure(audio);
      expect(structure.sections).toHaveLength(1);
      expect(structure.sections[0].startSeconds).toBe(0);
      expect(structure.sections[0].endSeconds).toBeCloseTo(60, 6);
      expect(structure.dropIndex).toBeNull();
      expect(structure.confidence).toBe(0);
    }
  });

  it('degrades gracefully on a track far too short to have structure', () => {
    for (const seconds of [8, 1, 0.05]) {
      const structure = analyseSongStructure(toneAudio(seconds));
      expect(structure.sections).toHaveLength(1);
      expect(structure.sections[0].durationSeconds).toBeCloseTo(seconds, 3);
      expect(structure.dropIndex).toBeNull();
      expect(structure.novelty.values.length).toBe(structure.novelty.times.length);
    }
  });

  it('returns an empty structure for an empty buffer rather than throwing', () => {
    const structure = analyseSongStructure(silentAudio(0));
    expect(structure.sections).toEqual([]);
    expect(structure.dropIndex).toBeNull();
    expect(structure.duration).toBe(0);
  });
});
