import { afterEach, describe, expect, it, vi } from 'vitest';
import { advanceTargetTurn, createTargetGame, randomTarget, recordTargetAttempt, scoreAttempt } from '../src/target-practice/target-game';
import { TargetPracticePage } from '../src/target-practice/target-practice-page';
import { BoschLaserMeasureAdapter } from '../src/bluetooth/bosch-laser-measure-adapter';
import type { ParsedMeasurement } from '../src/bluetooth/types';
import { SiteMeasureApp } from '../src/app';

afterEach(() => vi.restoreAllMocks());

describe('target practice', () => {
  it('chooses a target within the inclusive range at centimeter precision', () => {
    expect(randomTarget(0.5, 5, () => 0)).toBe(0.5);
    expect(randomTarget(0.5, 5, () => 0.999999)).toBe(5);
    expect(randomTarget(1.001, 1.019, () => 0)).toBe(1.01);
    expect(randomTarget(0.07, 0.29, () => 0)).toBe(0.07);
    expect(randomTarget(0.07, 0.29, () => 0.999999)).toBe(0.29);
    expect(() => randomTarget(2, 1)).toThrow();
    expect(() => randomTarget(0.001, 0.009)).toThrow();
  });

  it('scores distance from the target and preserves its direction', () => {
    expect(scoreAttempt(2, 2).points).toBe(100);
    expect(scoreAttempt(2, 2.005).points).toBe(99);
    expect(scoreAttempt(2, 2.125).points).toBe(87);
    expect(scoreAttempt(2, 1.9).differenceMeters).toBeCloseTo(-0.1);
    expect(scoreAttempt(2, 4).points).toBe(0);
    expect(() => scoreAttempt(2, 0)).toThrow();
    expect(() => scoreAttempt(2, Infinity)).toThrow();
  });

  it('lets each player attempt the same target once per round', () => {
    let game = createTargetGame([' Anna ', 'Bela'], 2, 1, 2, () => 0);
    expect(game.players).toEqual(['Anna', 'Bela']);
    game = recordTargetAttempt(game, 1.1);
    expect(game.attempts[0]).toMatchObject({ playerIndex: 0, round: 1, targetMeters: 1, points: 90 });
    expect(() => recordTargetAttempt(game, 1)).toThrow('Wait for the next turn');
    game = advanceTargetTurn(game, () => 0.999999);
    expect(game.target).toBe(1);
    game = recordTargetAttempt(game, 1);
    expect(game.attempts[1]).toMatchObject({ playerIndex: 1, round: 1, targetMeters: 1, points: 100 });
    game = advanceTargetTurn(game, () => 0.999999);
    expect(game.target).toBe(2);
    game = recordTargetAttempt(game, 2);
    game = advanceTargetTurn(game);
    game = recordTargetAttempt(game, 2.2);
    expect(game.attempts[3]).toMatchObject({ playerIndex: 1, round: 2, points: 80 });
    expect(advanceTargetTurn(game)).toBe(game);
    expect(() => recordTargetAttempt(game, 2)).toThrow('Wait for the next turn');
  });

  it('validates nicknames, round count, and range while allowing solo play', () => {
    expect(createTargetGame(['Solo'], 1, 1, 1).players).toEqual(['Solo']);
    expect(() => createTargetGame([], 2, 1, 2)).toThrow('unique nicknames');
    expect(() => createTargetGame(['Anna', ' anna '], 2, 1, 2)).toThrow('unique nicknames');
    expect(() => createTargetGame(['  '], 2, 1, 2)).toThrow('unique nicknames');
    expect(() => createTargetGame(['A'], 0, 1, 2)).toThrow('rounds');
    expect(() => createTargetGame(['A'], 21, 1, 2)).toThrow('rounds');
    expect(() => createTargetGame(['A'], 2, 0, 2)).toThrow('target range');
  });

  it('gives each turn a different target when the range allows it', () => {
    let game = createTargetGame(['Anna', 'Bela'], 2, 1, 1.01, () => 0, 'individual');
    for (const target of [1, 1.01, 1, 1.01]) {
      expect(game.target).toBe(target);
      game = advanceTargetTurn(recordTargetAttempt(game, target), () => 0);
    }
    let fixedRange = createTargetGame(['Anna', 'Bela'], 1, 1, 1, () => 0, 'individual');
    fixedRange = advanceTargetTurn(recordTargetAttempt(fixedRange, 1));
    expect(fixedRange.target).toBe(1);
  });

  it('plays each player through the same targets in a shuffled order', () => {
    const values = [0, 0.5, 0.999999, 0.999999, 0.999999];
    let game = createTargetGame(['Anna', 'Bela'], 3, 1, 2, () => values.shift() ?? 0, 'shuffled');
    const sequences: number[][] = [[], []];
    for (let index = 0; index < 6; index++) {
      game = recordTargetAttempt(game, game.target);
      const attempt = game.attempts[index];
      expect(attempt.playerIndex).toBe(Math.floor(index / 3));
      expect(attempt.round).toBe(index % 3 + 1);
      sequences[attempt.playerIndex].push(attempt.targetMeters);
      game = advanceTargetTurn(game);
    }
    expect(sequences[0]).toEqual([1, 1.51, 2]);
    expect(sequences[1]).not.toEqual(sequences[0]);
    expect([...sequences[1]].sort()).toEqual([...sequences[0]].sort());
  });

  it('uses distinct shuffled targets where possible, even with repeated random values', () => {
    const game = createTargetGame(['Anna', 'Bela'], 4, 1, 1.02, () => 0, 'shuffled');
    expect(new Set(game.sequences[0]).size).toBe(3);
    expect([...game.sequences[1]].sort()).toEqual([...game.sequences[0]].sort());
    expect(game.sequences[1]).not.toEqual(game.sequences[0]);
  });

  it.each([
    ['fixed', [1.5, 1.5, 1.5]],
    ['ascending', [1, 1.5, 2]],
    ['descending', [2, 1.5, 1]],
  ] as const)('plays %s targets shared by each round', (mode, targets) => {
    let game = createTargetGame(['Anna', 'Bela'], 3, 1, 2, () => 0.5, mode);
    for (const target of targets) {
      for (let player = 0; player < 2; player++) {
        expect(game.target).toBe(target);
        game = advanceTargetTurn(recordTargetAttempt(game, target), () => 0);
      }
    }
    expect(game.attempts).toHaveLength(6);
  });
});

describe('target practice page', () => {
  it('runs player-by-player mode with correct turn and round labels', () => {
    const page = new TargetPracticePage(localStorage, vi.fn(), vi.fn());
    const main = document.createElement('main');
    page.render(main);
    const settings = main.querySelector<HTMLFormElement>('.target-settings')!;
    settings.querySelector<HTMLSelectElement>('select')!.value = 'shuffled';
    settings.querySelectorAll<HTMLInputElement>('input[type=number]')[2].value = '2';
    settings.dispatchEvent(new Event('submit', { cancelable: true }));
    const next = main.querySelector<HTMLButtonElement>('[data-target-next]')!;
    expect(main.querySelector('[data-target-player]')?.textContent).toBe("Player 1's turn");
    page.addMeasurement({ valueMeters: 1 });
    expect(next.textContent).toBe('Next round');
    next.click();
    expect(main.querySelector('[data-target-progress]')?.textContent).toBe('Round 2 / 2');
    expect(main.querySelector('[data-target-player]')?.textContent).toBe("Player 1's turn");
    page.addMeasurement({ valueMeters: 1 });
    expect(next.textContent).toBe('Next player');
    next.click();
    expect(main.querySelector('[data-target-progress]')?.textContent).toBe('Round 1 / 2');
    expect(main.querySelector('[data-target-player]')?.textContent).toBe("Player 2's turn");
    page.dispose();
  });

  it('runs shared rounds for named players and ranks their total scores', () => {
    const page = new TargetPracticePage(localStorage, vi.fn(), vi.fn());
    const main = document.createElement('main');
    page.render(main);
    const settings = main.querySelector<HTMLFormElement>('.target-settings')!;
    const [first, second] = settings.querySelectorAll<HTMLInputElement>('.target-player-input');
    first.value = 'Anna';
    second.value = 'Bela';
    const [minimum, maximum, rounds] = settings.querySelectorAll<HTMLInputElement>('input[type=number]');
    minimum.value = '1';
    maximum.value = '2';
    rounds.value = '2';
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.999999);
    settings.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(main.querySelector<HTMLDetailsElement>('.target-setup')!.open).toBe(false);
    const next = main.querySelector<HTMLButtonElement>('[data-target-next]')!;
    expect(next.textContent).toBe('Next player');
    expect(main.querySelector('[data-target-player]')?.textContent).toBe("Anna's turn");
    expect(main.querySelector('[data-target-value]')?.textContent).toBe('1.00');
    expect(page.addMeasurement({ valueMeters: 1.1 })).toBe(true);
    expect(next.textContent).toBe('Next player');
    next.click();
    expect(main.querySelector('[data-target-player]')?.textContent).toBe("Bela's turn");
    expect(main.querySelector('[data-target-value]')?.textContent).toBe('1.00');
    expect(page.addMeasurement({ valueMeters: 1 })).toBe(true);
    expect(next.textContent).toBe('Next round');
    next.click();
    expect(main.querySelector('[data-target-progress]')?.textContent).toBe('Round 2 / 2');
    expect(main.querySelector('[data-target-value]')?.textContent).toBe('2.00');
    expect(page.addMeasurement({ valueMeters: 2 })).toBe(true);
    next.click();
    expect(page.addMeasurement({ valueMeters: 2.2 })).toBe(true);
    expect(main.querySelector('[data-target-progress]')?.textContent).toBe('Game complete');
    expect(main.querySelector('[data-target-player]')?.textContent).toBe('Winner: Anna');
    expect(main.querySelector('[data-target-total]')?.textContent).toBe('190 / 200 points');
    expect([...main.querySelectorAll('.target-leaderboard-row')].map((row) => row.textContent)).toEqual(['Anna190 pts', 'Bela180 pts']);
    expect([...main.querySelectorAll('.target-history-row')].map((row) => row.textContent)).toEqual([
      'Round 1 · Anna · 1.00 m → 1.100 m90 pts',
      'Round 1 · Bela · 1.00 m → 1.000 m100 pts',
      'Round 2 · Anna · 2.00 m → 2.000 m100 pts',
      'Round 2 · Bela · 2.00 m → 2.200 m80 pts',
    ]);
    page.dispose();
  });

  it('handles tied winners and rejects duplicate nicknames without resetting the game', () => {
    const toast = vi.fn();
    const page = new TargetPracticePage(localStorage, toast, vi.fn());
    const main = document.createElement('main');
    page.render(main);
    const settings = main.querySelector<HTMLFormElement>('.target-settings')!;
    const [first, second] = settings.querySelectorAll<HTMLInputElement>('.target-player-input');
    first.value = 'Anna';
    second.value = 'Bela';
    const [minimum, maximum, rounds] = settings.querySelectorAll<HTMLInputElement>('input[type=number]');
    minimum.value = '2';
    maximum.value = '2';
    rounds.value = '1';
    settings.dispatchEvent(new Event('submit', { cancelable: true }));
    page.addMeasurement({ valueMeters: 2 });
    main.querySelector<HTMLButtonElement>('[data-target-next]')!.click();
    page.addMeasurement({ valueMeters: 2 });
    expect(main.querySelector('[data-target-player]')?.textContent).toBe('Winners: Anna, Bela');
    second.value = ' anna ';
    settings.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(toast).toHaveBeenCalledWith('Enter 1 to 8 unique nicknames, each up to 20 characters.');
    expect(main.querySelector('[data-target-progress]')?.textContent).toBe('Game complete');
    expect(main.querySelectorAll('.target-history-row')).toHaveLength(2);
    page.dispose();
  });

  it('adds and removes players while keeping at least one', () => {
    const page = new TargetPracticePage(localStorage, vi.fn(), vi.fn());
    const main = document.createElement('main');
    page.render(main);
    const add = [...main.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === 'Add player')!;
    add.click();
    expect(main.querySelectorAll('.target-player-input')).toHaveLength(3);
    main.querySelector<HTMLButtonElement>('[aria-label="Remove player 2"]')!.click();
    expect(main.querySelectorAll('.target-player-input')).toHaveLength(2);
    main.querySelector<HTMLButtonElement>('[aria-label="Remove player 2"]')!.click();
    expect(main.querySelector<HTMLButtonElement>('[aria-label="Remove player 1"]')!.disabled).toBe(true);
    page.dispose();
  });

  it('plays five rounds, rejects extra readings, and resets for a new game', () => {
    const page = new TargetPracticePage(localStorage, vi.fn(), vi.fn());
    const main = document.createElement('main');
    page.render(main);
    const settings = main.querySelector<HTMLFormElement>('.target-settings')!;
    settings.querySelectorAll<HTMLButtonElement>('.target-remove-player')[1].click();
    const [minimum, maximum] = settings.querySelectorAll<HTMLInputElement>('input[type=number]');
    minimum.value = '2';
    maximum.value = '2';
    settings.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(main.querySelector('[data-target-value]')?.textContent).toBe('2.00');
    const form = main.querySelector<HTMLFormElement>('.target-manual')!;
    const distance = form.querySelector<HTMLInputElement>('input')!;
    distance.value = '2.1';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(main.querySelector('[data-target-result]')?.textContent).toContain('90 points');
    expect(main.querySelector('[data-target-result]')?.textContent).toContain('Too far');
    expect(page.addMeasurement({ valueMeters: 2 })).toBe(false);
    expect(main.querySelectorAll('.target-history-row')).toHaveLength(1);
    for (let round = 1; round < 5; round++) {
      main.querySelector<HTMLButtonElement>('[data-target-next]')!.click();
      expect(page.addMeasurement({ valueMeters: 2 })).toBe(true);
    }
    expect(main.querySelector('[data-target-progress]')?.textContent).toBe('Game complete');
    expect(main.querySelector('[data-target-total]')?.textContent).toBe('490 / 500 points');
    expect(main.querySelector<HTMLButtonElement>('[data-target-next]')!.hidden).toBe(true);
    expect(page.addMeasurement({ valueMeters: 2 })).toBe(false);
    settings.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(main.querySelector('[data-target-progress]')?.textContent).toBe('Round 1 / 5');
    expect(main.querySelectorAll('.target-history-row')).toHaveLength(0);
    page.dispose();
  });

  it('preserves the game when the target range or measurement is invalid', () => {
    const toast = vi.fn();
    const page = new TargetPracticePage(localStorage, toast, vi.fn());
    const main = document.createElement('main');
    page.render(main);
    expect(page.addMeasurement({ valueMeters: -1 })).toBe(false);
    expect(toast).toHaveBeenCalledWith('Enter a positive distance.');
    expect(page.addMeasurement({ valueMeters: 2 })).toBe(true);
    const settings = main.querySelector<HTMLFormElement>('.target-settings')!;
    const [minimum, maximum] = settings.querySelectorAll<HTMLInputElement>('input[type=number]');
    minimum.value = '5';
    maximum.value = '1';
    settings.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(toast).toHaveBeenCalledWith('Choose a target range between 0.01 m and 100 m.');
    expect(main.querySelectorAll('.target-history-row')).toHaveLength(1);
    page.dispose();
  });

  it('uses laser readings once per round and ignores callbacks after leaving', async () => {
    let receive!: (measurement: ParsedMeasurement) => void;
    let finishConnection!: () => void;
    const disconnect = vi.spyOn(BoschLaserMeasureAdapter.prototype, 'disconnect').mockResolvedValue();
    const connect = vi.spyOn(BoschLaserMeasureAdapter.prototype, 'connect').mockImplementation((onMeasurement) => {
      receive = onMeasurement;
      return new Promise<void>((resolve) => { finishConnection = resolve; });
    });
    const page = new TargetPracticePage(localStorage, vi.fn(), vi.fn());
    const main = document.createElement('main');
    page.render(main);
    const pending = (page as unknown as { connectLaser(): Promise<void> }).connectLaser();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    const reading = { valueMeters: 2, capturedAt: '2026-01-01T00:00:00Z', deviceName: 'Laser' };
    receive(reading);
    receive(reading);
    expect(main.querySelectorAll('.target-history-row')).toHaveLength(1);
    page.dispose();
    receive(reading);
    finishConnection();
    await pending;
    expect(main.querySelectorAll('.target-history-row')).toHaveLength(1);
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it('opens from Misc and cleans up on return', () => {
    const originalUrl = window.location.pathname + window.location.search + window.location.hash;
    history.replaceState(null, '', '#misc');
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as { targetPracticePage: TargetPracticePage };
    const dispose = vi.spyOn(app.targetPracticePage, 'dispose');
    [...root.querySelectorAll<HTMLButtonElement>('.misc-feature-button')].find((item) => item.textContent?.startsWith('Target Practice'))!.click();
    expect(window.location.hash).toBe('#target-practice');
    expect(root.querySelector('.target-page h1')?.textContent).toBe('Target Practice');
    [...root.querySelectorAll<HTMLButtonElement>('.target-page button')].find((item) => item.textContent === 'Back to Misc')!.click();
    expect(window.location.hash).toBe('#misc');
    expect(dispose).toHaveBeenCalledOnce();
    history.replaceState(null, '', originalUrl);
    root.remove();
  });
});