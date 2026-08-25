import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, Trackgen, normaliseBrightness, type Input } from '../game';
import type { Section, SongStructure } from '../../../engine/sections';

const DT = 1 / 60;
const EMPTY_NOVELTY = { values: new Float32Array(0), times: new Float64Array(0) };

/** A minimal, valid `Section` — tests only override what they care about. */
function section(overrides: { index: number; startSeconds: number; endSeconds: number }): Section {
  return {
    index: overrides.index,
    startSeconds: overrides.startSeconds,
    endSeconds: overrides.endSeconds,
    durationSeconds: overrides.endSeconds - overrides.startSeconds,
    intensity: 0.5,
    loudnessDb: -20,
    boundaryStrength: 0.5,
    isDrop: false,
    startBeat: null,
    beatCount: null,
  };
}

/** A synthetic `SongStructure` — the same "construct fake data directly"
 *  precedent Drop Siege's own tests use for a structure. */
function structure(sections: Section[], dropIndex: number | null): SongStructure {
  return {
    sections,
    dropIndex,
    duration: sections.length > 0 ? sections[sections.length - 1].endSeconds : 0,
    beatSynchronous: false,
    grid: null,
    confidence: 0.8,
    novelty: EMPTY_NOVELTY,
  };
}

/** Two 30-second sections spanning a 60-second track, the second one the drop. */
function twoBiomeTrack(): SongStructure {
  return structure(
    [section({ index: 0, startSeconds: 0, endSeconds: 30 }), section({ index: 1, startSeconds: 30, endSeconds: 60 })],
    1,
  );
}

function at(positionSeconds: number): Input {
  return { positionSeconds };
}

/** Start (or continue) the round with a jump, then hold `positionSeconds`
 *  fixed at `positionSeconds` for the whole arc — long enough for the arc's
 *  above-`pickupHeight` window to sweep past, so any collectible sitting
 *  exactly there gets a real chance to be grabbed. */
function jumpAt(game: Trackgen, positionSeconds: number): void {
  game.jump();
  const frames = Math.round(DEFAULT_CONFIG.jumpDuration / DT) + 2;
  for (let i = 0; i < frames; i++) game.update(DT, at(positionSeconds));
}

describe('normaliseBrightness', () => {
  it('maps the low end of the range to 0 and the high end to 1', () => {
    expect(normaliseBrightness(DEFAULT_CONFIG.centroidLowHz)).toBeCloseTo(0, 5);
    expect(normaliseBrightness(DEFAULT_CONFIG.centroidHighHz)).toBeCloseTo(1, 5);
  });

  it('maps the geometric mean to 0.5, since the scale is log-spaced', () => {
    const mid = Math.sqrt(DEFAULT_CONFIG.centroidLowHz * DEFAULT_CONFIG.centroidHighHz);
    expect(normaliseBrightness(mid)).toBeCloseTo(0.5, 5);
  });

  it('clamps outside the range and treats non-positive Hz as 0', () => {
    expect(normaliseBrightness(1)).toBe(0);
    expect(normaliseBrightness(50_000)).toBe(1);
    expect(normaliseBrightness(0)).toBe(0);
    expect(normaliseBrightness(-10)).toBe(0);
  });
});

describe('DEFAULT_CONFIG pickup timing', () => {
  it('leaves the arc above pickupHeight for comfortably more than twice the pickup window', () => {
    // Regression guard mirroring Overtone's own clearance-window test: this
    // arithmetic catches a config change that quietly makes every collectible
    // ungettable no matter how well a tap is timed.
    const k = 1 - DEFAULT_CONFIG.pickupHeight / DEFAULT_CONFIG.jumpPeakHeight;
    const aboveThresholdDuration = Math.sqrt(k) * DEFAULT_CONFIG.jumpDuration;
    expect(aboveThresholdDuration).toBeGreaterThan(DEFAULT_CONFIG.pickupWindowSeconds * 2);
  });
});

describe('starting the round', () => {
  it('stays in ready and does nothing if jump is tapped before a level is configured', () => {
    const game = new Trackgen();
    game.jump();
    expect(game.phase).toBe('ready');
    expect(game.jumping).toBe(false);
  });

  it('the first tap starts the round and performs the jump in one motion', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [200, 200], []);
    game.jump();
    expect(game.phase).toBe('playing');
    expect(game.jumping).toBe(true);
    expect(game.jumpElapsed).toBe(0);
  });
});

describe('readyHint', () => {
  it('says the track is being analysed before a level exists', () => {
    expect(new Trackgen().readyHint).toBe('Analysing the track');
  });

  it('invites a tap once a level has been configured', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [200, 200], []);
    expect(game.readyHint).toMatch(/tap/i);
  });
});

describe('jump arc', () => {
  it('jumpHeight is 0 before jumping, rises then falls back to 0 by the end of the arc', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [200, 200], []);
    expect(game.jumpHeight()).toBe(0);

    game.jump();
    game.update(DT, at(0));
    const early = game.jumpHeight();
    expect(early).toBeGreaterThan(0);

    for (let i = 0; i < Math.round(DEFAULT_CONFIG.jumpDuration / DT / 2); i++) game.update(DT, at(0));
    const mid = game.jumpHeight();
    expect(mid).toBeGreaterThan(early);

    for (let i = 0; i < Math.round(DEFAULT_CONFIG.jumpDuration / DT); i++) game.update(DT, at(0));
    expect(game.jumpHeight()).toBe(0);
    expect(game.jumping).toBe(false);
  });

  it('re-tapping mid-air restarts the jump arc', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [200, 200], []);
    game.jump();
    for (let i = 0; i < 20; i++) game.update(DT, at(0));
    expect(game.jumping).toBe(true);
    game.jump();
    expect(game.jumpElapsed).toBe(0);
  });
});

describe('world position', () => {
  it('tracks positionSeconds directly from the update input, not an accumulated distance', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [200, 200], []);
    game.update(DT, at(12.5));
    expect(game.positionSeconds).toBe(12.5);
    // A seek backwards must be reflected exactly, not smoothed toward — this
    // is what "always source.position(), never dt-accumulated" means in practice.
    game.update(DT, at(3));
    expect(game.positionSeconds).toBe(3);
  });

  it('derives playerWorldX and a collectible world x from the same fixed scale', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [200, 200], [10]);
    game.update(DT, at(7));
    expect(game.playerWorldX()).toBeCloseTo(7 * DEFAULT_CONFIG.worldUnitsPerSecond, 10);
    expect(game.worldX(game.collectibles[0].atSeconds)).toBeCloseTo(10 * DEFAULT_CONFIG.worldUnitsPerSecond, 10);
  });
});

describe('collectible placement', () => {
  it('builds a sorted, all-ungrabbed collectible list from a given timestamp list', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [200, 200], [42, 5, 18]);
    expect(game.collectibles.map((c) => c.atSeconds)).toEqual([5, 18, 42]);
    expect(game.collectibles.every((c) => !c.grabbed)).toBe(true);
  });

  it('handles an empty collectible list', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [200, 200], []);
    expect(game.collectibles).toHaveLength(0);
  });
});

describe('collectible pickup', () => {
  it('grabs a collectible when airborne past pickupHeight within the pickup window', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [200, 200], [10]);
    jumpAt(game, 10);
    expect(game.collectibles[0].grabbed).toBe(true);
  });

  it('does not grab a collectible while not jumping, even exactly at its position', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [200, 200], [10]);
    // Start the round with a throwaway jump far from the collectible, then run
    // out the clock on it so `jumping` goes back to false while `phase` stays
    // 'playing'.
    game.jump();
    const frames = Math.round(DEFAULT_CONFIG.jumpDuration / DT) + 5;
    for (let i = 0; i < frames; i++) game.update(DT, at(50));
    expect(game.jumping).toBe(false);

    game.update(DT, at(10));
    expect(game.collectibles[0].grabbed).toBe(false);
  });

  it('does not grab a collectible outside the pickup window, even mid-jump', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [200, 200], [10]);
    jumpAt(game, 10 + DEFAULT_CONFIG.pickupWindowSeconds * 3);
    expect(game.collectibles[0].grabbed).toBe(false);
  });

  it('does not double count a collectible that is already grabbed', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [200, 200], [10]);
    jumpAt(game, 10);
    expect(Math.floor(game.score)).toBe(1);
    jumpAt(game, 10);
    expect(Math.floor(game.score)).toBe(1);
  });
});

describe('biome lookup', () => {
  it('maps each section centroid Hz through normaliseBrightness into brightness01', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [DEFAULT_CONFIG.centroidLowHz, DEFAULT_CONFIG.centroidHighHz], []);
    expect(game.biomes[0].brightness01).toBeCloseTo(0, 5);
    expect(game.biomes[1].brightness01).toBeCloseTo(1, 5);
  });

  it('flags isDrop only on the section the structure names as the drop', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [200, 200], []);
    expect(game.biomes[0].isDrop).toBe(false);
    expect(game.biomes[1].isDrop).toBe(true);
  });

  it('flags no drop biome when the structure has none', () => {
    const game = new Trackgen();
    const noDrop = structure(
      [section({ index: 0, startSeconds: 0, endSeconds: 30 }), section({ index: 1, startSeconds: 30, endSeconds: 60 })],
      null,
    );
    game.configureTrack(noDrop, [200, 200], []);
    expect(game.biomes.every((biome) => !biome.isDrop)).toBe(true);
  });

  it('biomeIndexAt finds the section a position falls in, clamping past the end', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [200, 200], []);
    expect(game.biomeIndexAt(0)).toBe(0);
    expect(game.biomeIndexAt(29.9)).toBe(0);
    expect(game.biomeIndexAt(30)).toBe(1);
    expect(game.biomeIndexAt(1000)).toBe(1);
  });

  it('reports no biome and a neutral brightness with no level configured', () => {
    const game = new Trackgen();
    expect(game.biomeIndexAt(10)).toBeNull();
    expect(game.brightnessAt(10)).toBe(0.5);
  });

  it('reads as the section own brightness away from a boundary', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [DEFAULT_CONFIG.centroidLowHz, DEFAULT_CONFIG.centroidHighHz], []);
    expect(game.brightnessAt(5)).toBeCloseTo(0, 5);
  });

  it('crossfades linearly into the next section over the last biomeCrossfadeSeconds', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [DEFAULT_CONFIG.centroidLowHz, DEFAULT_CONFIG.centroidHighHz], []);
    const span = DEFAULT_CONFIG.biomeCrossfadeSeconds;
    expect(game.brightnessAt(30 - span)).toBeCloseTo(0, 5); // crossfade not yet begun
    expect(game.brightnessAt(30 - span / 2)).toBeCloseTo(0.5, 5); // halfway blended
    expect(game.brightnessAt(30)).toBeCloseTo(1, 5); // fully into the new section
  });
});

describe('scoring', () => {
  it('encodes score as collectibles grabbed plus the total scaled into the fractional part', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [200, 200], [10, 20, 30]);
    expect(game.score).toBeCloseTo(3 / 10_000, 10); // nothing grabbed yet, three placed
    jumpAt(game, 10);
    const grabbed = Math.floor(game.score);
    const total = Math.round((game.score - grabbed) * 10_000);
    expect(grabbed).toBe(1);
    expect(total).toBe(3);
  });
});

describe('round end', () => {
  it('ends the round once position reaches the track duration', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [200, 200], []);
    game.jump();
    game.update(DT, at(59.95)); // within TRACK_END_EPSILON of the 60s duration
    expect(game.phase).toBe('over');
  });

  it('does not end the round while well short of the duration', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [200, 200], []);
    game.jump();
    game.update(DT, at(40));
    expect(game.phase).toBe('playing');
  });

  it('does not evaluate round-end while still in ready', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [200, 200], []);
    game.update(DT, at(60)); // position already at the duration, but never tapped
    expect(game.phase).toBe('ready');
  });
});

describe('reset', () => {
  it('returns to ready and un-grabs collectibles, while the level itself survives', () => {
    const game = new Trackgen();
    game.configureTrack(twoBiomeTrack(), [200, 200], [10, 20]);
    jumpAt(game, 10);
    expect(Math.floor(game.score)).toBe(1);

    game.reset();
    expect(game.phase).toBe('ready');
    expect(game.positionSeconds).toBe(0);
    expect(game.jumping).toBe(false);
    expect(game.collectibles.every((c) => !c.grabbed)).toBe(true);
    expect(game.collectibles.map((c) => c.atSeconds)).toEqual([10, 20]);
    expect(game.duration).toBe(60);
    expect(game.biomes).toHaveLength(2);
    expect(Math.floor(game.score)).toBe(0);
  });
});
