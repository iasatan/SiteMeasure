export interface TargetAttempt {
  targetMeters: number;
  measuredMeters: number;
  differenceMeters: number;
  points: number;
}

export function randomTarget(minMeters: number, maxMeters: number, random = Math.random): number {
  const minimum = Math.ceil(minMeters * 100 - 1e-8);
  const maximum = Math.floor(maxMeters * 100 + 1e-8);
  if (!Number.isFinite(minMeters) || !Number.isFinite(maxMeters) || minimum < 1 || maximum < minimum) throw new Error('Choose a valid target range in centimeters.');
  return (minimum + Math.floor(random() * (maximum - minimum + 1))) / 100;
}

export function scoreAttempt(targetMeters: number, measuredMeters: number): TargetAttempt {
  if (!Number.isFinite(targetMeters) || targetMeters <= 0 || !Number.isFinite(measuredMeters) || measuredMeters <= 0) throw new Error('Enter a positive distance.');
  const differenceMeters = measuredMeters - targetMeters;
  return { targetMeters, measuredMeters, differenceMeters, points: Math.max(0, 100 - Math.round(Math.abs(differenceMeters) * 100 + 1e-8)) };
}

export interface PlayerAttempt extends TargetAttempt {
  playerIndex: number;
  round: number;
}

export interface TargetGame {
  players: string[];
  rounds: number;
  minimum: number;
  maximum: number;
  target: number;
  attempts: PlayerAttempt[];
  awaitingNext: boolean;
}

export function createTargetGame(players: readonly string[], rounds: number, minimum: number, maximum: number, random = Math.random): TargetGame {
  const names = players.map((name) => name.trim());
  if (names.length < 1 || names.length > 8 || names.some((name) => !name || name.length > 20) || new Set(names.map((name) => name.toLocaleLowerCase())).size !== names.length) {
    throw new Error('Enter 1 to 8 unique nicknames, each up to 20 characters.');
  }
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) throw new Error('Choose between 1 and 20 rounds.');
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0.01 || maximum > 100 || minimum > maximum) throw new Error('Choose a target range between 0.01 m and 100 m.');
  return { players: names, rounds, minimum, maximum, target: randomTarget(minimum, maximum, random), attempts: [], awaitingNext: false };
}

export function recordTargetAttempt(game: TargetGame, measuredMeters: number): TargetGame {
  if (game.awaitingNext || game.attempts.length >= game.players.length * game.rounds) throw new Error('Wait for the next turn.');
  const index = game.attempts.length;
  const attempt = { ...scoreAttempt(game.target, measuredMeters), playerIndex: index % game.players.length, round: Math.floor(index / game.players.length) + 1 };
  return { ...game, attempts: [...game.attempts, attempt], awaitingNext: true };
}

export function advanceTargetTurn(game: TargetGame, random = Math.random): TargetGame {
  if (!game.awaitingNext || game.attempts.length >= game.players.length * game.rounds) return game;
  const newRound = game.attempts.length % game.players.length === 0;
  return { ...game, target: newRound ? randomTarget(game.minimum, game.maximum, random) : game.target, awaitingNext: false };
}