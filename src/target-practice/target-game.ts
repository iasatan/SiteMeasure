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

export type TargetGameMode = 'shared' | 'individual' | 'shuffled' | 'fixed' | 'ascending' | 'descending';

export interface TargetGame {
  players: string[];
  rounds: number;
  minimum: number;
  maximum: number;
  mode: TargetGameMode;
  sequences: number[][];
  target: number;
  attempts: PlayerAttempt[];
  awaitingNext: boolean;
}

export function targetTurn(game: TargetGame, index: number): { playerIndex: number; round: number } {
  return game.mode === 'shuffled'
    ? { playerIndex: Math.floor(index / game.rounds), round: index % game.rounds + 1 }
    : { playerIndex: index % game.players.length, round: Math.floor(index / game.players.length) + 1 };
}

export function createTargetGame(players: readonly string[], rounds: number, minimum: number, maximum: number, random = Math.random, mode: TargetGameMode = 'shared'): TargetGame {
  const names = players.map((name) => name.trim());
  if (names.length < 1 || names.length > 8 || names.some((name) => !name || name.length > 20) || new Set(names.map((name) => name.toLocaleLowerCase())).size !== names.length) {
    throw new Error('Enter 1 to 8 unique nicknames, each up to 20 characters.');
  }
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) throw new Error('Choose between 1 and 20 rounds.');
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0.01 || maximum > 100 || minimum > maximum) throw new Error('Choose a target range between 0.01 m and 100 m.');
  if (!['shared', 'individual', 'shuffled', 'fixed', 'ascending', 'descending'].includes(mode)) throw new Error('Choose a valid game mode.');
  const firstTarget = randomTarget(minimum, maximum, random);
  let sequences: number[][] = [];
  if (mode === 'shuffled') {
    const minCentimeters = Math.ceil(minimum * 100 - 1e-8);
    const maxCentimeters = Math.floor(maximum * 100 + 1e-8);
    const selected = [Math.round(firstTarget * 100)];
    while (selected.length < rounds && selected.length < maxCentimeters - minCentimeters + 1) {
      let next = minCentimeters + Math.floor(random() * (maxCentimeters - minCentimeters + 1 - selected.length));
      [...selected].sort((left, right) => left - right).forEach((used) => { if (next >= used) next++; });
      selected.push(next);
    }
    const targets = selected.map((value) => value / 100);
    while (targets.length < rounds) targets.push(randomTarget(minimum, maximum, random));
    sequences = names.map((_, playerIndex) => {
      const sequence = [...targets];
      if (playerIndex > 0) {
        for (let index = sequence.length - 1; index > 0; index--) {
          const other = Math.floor(random() * (index + 1));
          [sequence[index], sequence[other]] = [sequence[other], sequence[index]];
        }
        if (sequence.length > 1 && sequence.every((target, index) => target === targets[index])) sequence.push(sequence.shift()!);
      }
      return sequence;
    });
  }
  const target = mode === 'ascending' ? Math.ceil(minimum * 100 - 1e-8) / 100 : mode === 'descending' ? Math.floor(maximum * 100 + 1e-8) / 100 : firstTarget;
  return { players: names, rounds, minimum, maximum, mode, sequences, target, attempts: [], awaitingNext: false };
}

export function recordTargetAttempt(game: TargetGame, measuredMeters: number): TargetGame {
  if (game.awaitingNext || game.attempts.length >= game.players.length * game.rounds) throw new Error('Wait for the next turn.');
  const index = game.attempts.length;
  const attempt = { ...scoreAttempt(game.target, measuredMeters), ...targetTurn(game, index) };
  return { ...game, attempts: [...game.attempts, attempt], awaitingNext: true };
}

export function advanceTargetTurn(game: TargetGame, random = Math.random): TargetGame {
  if (!game.awaitingNext || game.attempts.length >= game.players.length * game.rounds) return game;
  const newRound = game.attempts.length % game.players.length === 0;
  let target = game.target;
  if (game.mode === 'shuffled') {
    const turn = targetTurn(game, game.attempts.length);
    target = game.sequences[turn.playerIndex][turn.round - 1];
  } else if (game.mode === 'individual') {
    const minimum = Math.ceil(game.minimum * 100 - 1e-8);
    const maximum = Math.floor(game.maximum * 100 + 1e-8);
    if (minimum !== maximum) {
      const previous = Math.round(game.target * 100);
      const next = minimum + Math.floor(random() * (maximum - minimum));
      target = (next >= previous ? next + 1 : next) / 100;
    }
  } else if (game.mode === 'shared' && newRound) {
    target = randomTarget(game.minimum, game.maximum, random);
  } else if ((game.mode === 'ascending' || game.mode === 'descending') && newRound) {
    const minimum = Math.ceil(game.minimum * 100 - 1e-8);
    const maximum = Math.floor(game.maximum * 100 + 1e-8);
    const fraction = Math.floor(game.attempts.length / game.players.length) / (game.rounds - 1);
    target = Math.round(game.mode === 'ascending' ? minimum + (maximum - minimum) * fraction : maximum - (maximum - minimum) * fraction) / 100;
  }
  return { ...game, target, awaitingNext: false };
}