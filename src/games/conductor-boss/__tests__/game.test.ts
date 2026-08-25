import { describe, expect, it } from 'vitest';
import { ConductorBoss, DEFAULT_CONFIG, type Config, type Input } from '../game';

const DT = 1 / 60;

const silent: Input = { bands: { bass: 0, lowMid: 0, mid: 0, high: 0 }, onset: false, level: 0 };
const present = (overrides: Partial<Input> = {}): Input => ({
  bands: { bass: 0.1, lowMid: 0.1, mid: 0.3, high: 0.1 },
  onset: false,
  level: 0.5,
  ...overrides,
});
const bassLow: Input = present({ bands: { bass: 0.1, lowMid: 0.1, mid: 0.3, high: 0.1 } });
const bassHit: Input = present({ bands: { bass: 0.9, lowMid: 0.1, mid: 0.1, high: 0.1 } });
/** An onset whose spectrum is bass-dominant — should NOT count as a
 *  higher-band projectile trigger. Kept under `bassThreshold` so this
 *  isolates the band-dominance classification from the separate rising-edge
 *  bass-hit trigger, which fires off `bands.bass` alone regardless of `onset`. */
const bassOnset: Input = present({ onset: true, bands: { bass: 0.4, lowMid: 0.1, mid: 0.1, high: 0.1 } });
/** An onset whose spectrum is high-dominant — the legal projectile trigger. */
const highOnset: Input = present({ onset: true, bands: { bass: 0.1, lowMid: 0.1, mid: 0.2, high: 0.9 } });

/** Sustain enough presence to leave 'ready'. */
function begin(game: ConductorBoss, frames = 30): void {
  for (let i = 0; i < frames; i++) game.update(DT, present());
}

function advance(game: ConductorBoss, seconds: number, input: Input = present()): void {
  for (let i = 0; i < Math.ceil(seconds / DT); i++) game.update(DT, input);
}

describe('ConductorBoss ready phase', () => {
  it('stays in ready while there is no sound', () => {
    const game = new ConductorBoss();
    for (let i = 0; i < 120; i++) game.update(DT, silent);
    expect(game.phase).toBe('ready');
  });

  it('does not start on a brief burst of sound', () => {
    const game = new ConductorBoss();
    for (let i = 0; i < 5; i++) game.update(DT, present());
    expect(game.phase).toBe('ready');
  });

  it('starts once presence is sustained for the hold time', () => {
    const game = new ConductorBoss();
    begin(game);
    expect(game.phase).toBe('playing');
  });

  it('lets the player position freely before the round starts', () => {
    const game = new ConductorBoss();
    game.setLane(2);
    expect(game.playerLane).toBe(2);
    expect(game.phase).toBe('ready');
  });
});

describe('ConductorBoss bass-hit detection', () => {
  it('does not telegraph a slam on a bass level under threshold', () => {
    const game = new ConductorBoss();
    begin(game);
    game.update(DT, bassLow);
    expect(game.attack).toBeNull();
  });

  it('telegraphs a slam on a bass rising edge crossing the threshold', () => {
    const game = new ConductorBoss();
    begin(game);
    game.update(DT, bassLow);
    game.update(DT, bassHit);
    expect(game.attack).not.toBeNull();
    expect(game.attack?.kind).toBe('slam');
    expect(game.attack?.stage).toBe('telegraph');
  });

  it('does not re-trigger on a sustained bass note, only on the rising edge', () => {
    const game = new ConductorBoss();
    begin(game);
    game.update(DT, bassLow);
    game.update(DT, bassHit);
    const firstAttack = game.attack;
    for (let i = 0; i < 5; i++) game.update(DT, bassHit); // held above threshold
    expect(game.attack).toBe(firstAttack); // still the same attack, no re-trigger
  });

  it('respects the bass cooldown between separate rising edges', () => {
    const config: Config = { ...DEFAULT_CONFIG, windupSeconds: 0.01, executeFlashSeconds: 0.01 };
    const game = new ConductorBoss(config);
    begin(game);
    game.update(DT, bassLow);
    game.update(DT, bassHit); // first edge
    expect(game.attack?.kind).toBe('slam');

    // Let the first attack fully resolve and clear well before the cooldown
    // has elapsed, so any second trigger is purely a cooldown question.
    advance(game, 0.05);
    expect(game.attack).toBeNull();

    game.update(DT, bassLow);
    game.update(DT, bassHit); // second edge, still within bassCooldownSeconds
    expect(game.attack).toBeNull(); // suppressed by cooldown

    advance(game, config.bassCooldownSeconds);
    game.update(DT, bassLow);
    game.update(DT, bassHit); // third edge, now past the cooldown
    expect(game.attack?.kind).toBe('slam');
  });
});

describe('ConductorBoss higher-band onset detection', () => {
  it('does not telegraph a projectile on an onset with a bass-dominant spectrum', () => {
    const game = new ConductorBoss();
    begin(game);
    game.update(DT, bassOnset);
    expect(game.attack).toBeNull();
  });

  it('telegraphs a projectile on an onset with a higher-band-dominant spectrum', () => {
    const game = new ConductorBoss();
    begin(game);
    game.update(DT, highOnset);
    expect(game.attack).not.toBeNull();
    expect(game.attack?.kind).toBe('projectile');
    expect(game.attack?.stage).toBe('telegraph');
  });

  it('ignores onset=false even with a higher-band-dominant spectrum', () => {
    const game = new ConductorBoss();
    begin(game);
    game.update(DT, present({ onset: false, bands: { bass: 0.1, lowMid: 0.1, mid: 0.1, high: 0.9 } }));
    expect(game.attack).toBeNull();
  });

  it('respects the onset cooldown between separate triggers', () => {
    const config: Config = { ...DEFAULT_CONFIG, windupSeconds: 0.01, executeFlashSeconds: 0.01 };
    const game = new ConductorBoss(config);
    begin(game);
    game.update(DT, highOnset);
    expect(game.attack?.kind).toBe('projectile');

    advance(game, 0.05);
    expect(game.attack).toBeNull();

    game.update(DT, highOnset); // within cooldown
    expect(game.attack).toBeNull();

    advance(game, config.onsetCooldownSeconds);
    game.update(DT, highOnset); // past the cooldown
    expect(game.attack?.kind).toBe('projectile');
  });

  it('a projectile telegraph captures the lane the player is in at that instant', () => {
    const game = new ConductorBoss();
    begin(game);
    game.setLane(2);
    game.update(DT, highOnset);
    expect(game.attack?.lane).toBe(2);
  });
});

describe('ConductorBoss one-attack-at-a-time', () => {
  it('ignores a new trigger while an attack is already telegraphing', () => {
    const game = new ConductorBoss();
    begin(game);
    game.update(DT, bassLow);
    game.update(DT, bassHit); // starts a slam
    const attack = game.attack;
    game.update(DT, highOnset); // a legal projectile trigger, but one is already in flight
    expect(game.attack).toBe(attack);
    expect(game.attack?.kind).toBe('slam');
  });
});

describe('ConductorBoss telegraph -> execute timing', () => {
  it('stays in the telegraph stage until windupSeconds elapses', () => {
    const game = new ConductorBoss();
    begin(game);
    game.update(DT, bassLow);
    game.update(DT, bassHit);
    expect(game.attack?.stage).toBe('telegraph');

    const framesShortOfWindup = Math.round(DEFAULT_CONFIG.windupSeconds / DT) - 2;
    for (let i = 0; i < framesShortOfWindup; i++) game.update(DT, present());
    expect(game.attack?.stage).toBe('telegraph');
  });

  it('advances to executing once windupSeconds elapses', () => {
    const game = new ConductorBoss();
    begin(game);
    game.update(DT, bassLow);
    game.update(DT, bassHit);
    advance(game, DEFAULT_CONFIG.windupSeconds + DT);
    expect(game.attack?.stage).toBe('executing');
  });

  it('clears the attack once executeFlashSeconds elapses after executing begins', () => {
    const game = new ConductorBoss();
    begin(game);
    game.update(DT, bassLow);
    game.update(DT, bassHit);
    advance(game, DEFAULT_CONFIG.windupSeconds + DT);
    expect(game.attack?.stage).toBe('executing');
    advance(game, DEFAULT_CONFIG.executeFlashSeconds + DT);
    expect(game.attack).toBeNull();
  });

  it('the same telegraph -> execute -> clear timing applies to a projectile', () => {
    const game = new ConductorBoss();
    begin(game);
    game.update(DT, highOnset);
    expect(game.attack?.stage).toBe('telegraph');
    advance(game, DEFAULT_CONFIG.windupSeconds + DT);
    expect(game.attack?.stage).toBe('executing');
    advance(game, DEFAULT_CONFIG.executeFlashSeconds + DT);
    expect(game.attack).toBeNull();
  });
});

describe('ConductorBoss dodge resolution', () => {
  it('a successful slam dodge (player in the safe lane) counters the boss and does not hurt the player', () => {
    const game = new ConductorBoss();
    begin(game);
    game.update(DT, bassLow);
    game.update(DT, bassHit); // first slam: safe lane is 0 (nextSlamSeq starts at 0)
    expect(game.attack?.lane).toBe(0);
    game.setLane(0);
    const healthBefore = game.health;
    const bossHealthBefore = game.bossHealth;
    advance(game, DEFAULT_CONFIG.windupSeconds + DT);
    expect(game.health).toBe(healthBefore);
    expect(game.bossHealth).toBe(bossHealthBefore - DEFAULT_CONFIG.slamBossCounterDamage);
    expect(game.score).toBe(1);
  });

  it('a failed slam dodge (player outside the safe lane) hurts the player, not the boss', () => {
    const game = new ConductorBoss();
    begin(game);
    game.update(DT, bassLow);
    game.update(DT, bassHit); // safe lane is 0
    game.setLane(1); // not the safe lane
    const healthBefore = game.health;
    const bossHealthBefore = game.bossHealth;
    advance(game, DEFAULT_CONFIG.windupSeconds + DT);
    expect(game.health).toBe(healthBefore - DEFAULT_CONFIG.slamPlayerDamage);
    expect(game.bossHealth).toBe(bossHealthBefore);
    expect(game.score).toBe(0);
  });

  it('a successful projectile dodge (player leaves the targeted lane) counters the boss', () => {
    const game = new ConductorBoss();
    begin(game);
    game.setLane(2);
    game.update(DT, highOnset); // targets lane 2
    expect(game.attack?.lane).toBe(2);
    game.setLane(0); // dodge away
    const healthBefore = game.health;
    const bossHealthBefore = game.bossHealth;
    advance(game, DEFAULT_CONFIG.windupSeconds + DT);
    expect(game.health).toBe(healthBefore);
    expect(game.bossHealth).toBe(bossHealthBefore - DEFAULT_CONFIG.projectileBossCounterDamage);
    expect(game.score).toBe(1);
  });

  it('a failed projectile dodge (player stays in the targeted lane) hurts the player', () => {
    const game = new ConductorBoss();
    begin(game);
    game.setLane(2);
    game.update(DT, highOnset); // targets lane 2
    // stays in lane 2
    const healthBefore = game.health;
    const bossHealthBefore = game.bossHealth;
    advance(game, DEFAULT_CONFIG.windupSeconds + DT);
    expect(game.health).toBe(healthBefore - DEFAULT_CONFIG.projectilePlayerDamage);
    expect(game.bossHealth).toBe(bossHealthBefore);
    expect(game.score).toBe(0);
  });

  it('resolution only checks the lane at the instant the windup ends, not during the executing flash', () => {
    const game = new ConductorBoss();
    begin(game);
    game.update(DT, bassLow);
    game.update(DT, bassHit); // safe lane is 0
    game.setLane(0); // dodge successfully
    advance(game, DEFAULT_CONFIG.windupSeconds + DT);
    const bossHealthAfterResolve = game.bossHealth;
    game.setLane(1); // moving after resolution must not re-trigger damage
    advance(game, DEFAULT_CONFIG.executeFlashSeconds + DT);
    expect(game.bossHealth).toBe(bossHealthAfterResolve);
    expect(game.health).toBe(DEFAULT_CONFIG.startHealth);
  });
});

describe('ConductorBoss victory and defeat', () => {
  it('ends in victory once the boss health empties', () => {
    const config: Config = { ...DEFAULT_CONFIG, bossStartHealth: 2, slamBossCounterDamage: 2 };
    const game = new ConductorBoss(config);
    begin(game);
    game.update(DT, bassLow);
    game.update(DT, bassHit); // safe lane 0
    game.setLane(0);
    advance(game, config.windupSeconds + DT);
    expect(game.bossHealth).toBe(0);
    expect(game.phase).toBe('over');
    expect(game.victory).toBe(true);
    expect(game.defeated).toBe(false);
  });

  it('ends in defeat once the player health empties', () => {
    const config: Config = { ...DEFAULT_CONFIG, startHealth: 2, slamPlayerDamage: 2 };
    const game = new ConductorBoss(config);
    begin(game);
    game.update(DT, bassLow);
    game.update(DT, bassHit); // safe lane 0
    game.setLane(1); // fail the dodge
    advance(game, config.windupSeconds + DT);
    expect(game.health).toBe(0);
    expect(game.phase).toBe('over');
    expect(game.defeated).toBe(true);
    expect(game.victory).toBe(false);
  });

  it('stops updating once the round is over', () => {
    const config: Config = { ...DEFAULT_CONFIG, startHealth: 2, slamPlayerDamage: 2 };
    const game = new ConductorBoss(config);
    begin(game);
    game.update(DT, bassLow);
    game.update(DT, bassHit);
    game.setLane(1);
    advance(game, config.windupSeconds + DT);
    expect(game.phase).toBe('over');
    const healthAfterOver = game.health;
    advance(game, 5, highOnset);
    expect(game.health).toBe(healthAfterOver);
    expect(game.phase).toBe('over');
  });
});

describe('ConductorBoss scoring', () => {
  it('score counts successful counters, not boss health remaining', () => {
    const game = new ConductorBoss();
    begin(game);
    expect(game.score).toBe(0);

    game.update(DT, bassLow);
    game.update(DT, bassHit); // safe lane 0
    game.setLane(0);
    advance(game, DEFAULT_CONFIG.windupSeconds + DT + DEFAULT_CONFIG.executeFlashSeconds + DT);
    expect(game.score).toBe(1);

    game.update(DT, bassLow);
    game.update(DT, bassHit); // next safe lane is 1
    expect(game.attack?.lane).toBe(1);
    game.setLane(1);
    advance(game, DEFAULT_CONFIG.windupSeconds + DT);
    expect(game.score).toBe(2);
  });

  it('a failed dodge does not increase score', () => {
    const game = new ConductorBoss();
    begin(game);
    game.update(DT, bassLow);
    game.update(DT, bassHit);
    game.setLane((((game.attack!.lane as number) + 1) % 3) as 0 | 1 | 2); // deliberately wrong
    advance(game, DEFAULT_CONFIG.windupSeconds + DT);
    expect(game.score).toBe(0);
  });
});

describe('ConductorBoss reset', () => {
  it('resets cleanly back to a fresh ready round', () => {
    const game = new ConductorBoss();
    begin(game);
    game.setLane(2);
    game.update(DT, bassLow);
    game.update(DT, bassHit);
    advance(game, DEFAULT_CONFIG.windupSeconds + DT);

    game.reset();
    expect(game.phase).toBe('ready');
    expect(game.score).toBe(0);
    expect(game.health).toBe(DEFAULT_CONFIG.startHealth);
    expect(game.bossHealth).toBe(DEFAULT_CONFIG.bossStartHealth);
    expect(game.playerLane).toBe(1);
    expect(game.attack).toBeNull();
    expect(game.defeated).toBe(false);
    expect(game.victory).toBe(false);
  });

  it('reset also clears cooldowns, so a bass hit right after reset can trigger immediately', () => {
    const game = new ConductorBoss();
    begin(game);
    game.update(DT, bassLow);
    game.update(DT, bassHit);
    game.reset();
    begin(game);
    game.update(DT, bassLow);
    game.update(DT, bassHit);
    expect(game.attack?.kind).toBe('slam');
  });
});
