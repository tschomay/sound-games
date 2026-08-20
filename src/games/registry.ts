/** Every playable game. The menu and the router are both built from this. */
import { humFlyer } from './hum-flyer';
import { quietGame } from './quiet-game';
import type { GameDefinition } from '../engine/game';

export const GAMES: readonly GameDefinition[] = [humFlyer, quietGame];

export function findGame(id: string): GameDefinition | undefined {
  return GAMES.find((game) => game.id === id);
}
