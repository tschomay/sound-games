/** Every playable game. The menu and the router are both built from this. */
import { humFlyer } from './hum-flyer';
import { quietGame } from './quiet-game';
import { sonarMaze } from './sonar-maze';
import { clapRunner } from './clap-runner';
import { voiceLineRider } from './voice-line-rider';
import { vowelSteeringSpike } from './vowel-steering-spike';
import { ecosystemGarden } from './ecosystem-garden';
import { rhythmGatedCombat } from './rhythm-gated-combat';
import type { GameDefinition } from '../engine/game';

export const GAMES: readonly GameDefinition[] = [
  humFlyer,
  quietGame,
  sonarMaze,
  clapRunner,
  voiceLineRider,
  vowelSteeringSpike,
  ecosystemGarden,
  rhythmGatedCombat,
];

export function findGame(id: string): GameDefinition | undefined {
  return GAMES.find((game) => game.id === id);
}
