import { BoschLaserMeasureAdapter } from '../bluetooth/bosch-laser-measure-adapter';
import { loadCustomBoschProfile } from '../bluetooth/custom-bosch-profile';
import { selectBluetoothProvider } from '../bluetooth/providers/select-bluetooth-provider';
import type { BluetoothConnectionState, LaserMeasureAdapter, ParsedMeasurement } from '../bluetooth/types';
import { advanceTargetTurn, createTargetGame, recordTargetAttempt, targetTurn } from './target-game';
import type { TargetGameMode } from './target-game';

function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

export class TargetPracticePage {
  private container: HTMLElement | null = null;
  private adapter: LaserMeasureAdapter | null = null;
  private connectionGeneration = 0;
  private state: BluetoothConnectionState = 'ready';
  private detail = '';
  private readonly provider = selectBluetoothProvider();
  private game = createTargetGame(['Player 1', 'Player 2'], 5, 0.5, 5);

  constructor(private readonly storage: Storage, private readonly toast: (message: string) => void, private readonly onBack: () => void) {}

  render(main: HTMLElement): void {
    this.container = main;
    main.replaceChildren();
    const page = el('section', 'page target-page');
    const heading = el('div', 'page-heading');
    const title = el('div');
    title.append(el('p', 'eyebrow', 'Misc'), el('h1', '', 'Target Practice'));
    heading.append(title, button('Back to Misc', 'button quiet compact', this.onBack));
    page.append(heading);

    const controls = el('div', 'target-controls');
    controls.append(
      button('Connect laser', 'button primary compact', () => void this.connectLaser()),
      button('Read current', 'button quiet compact', () => void this.readCurrent()),
      button('Disconnect', 'button quiet compact', () => void this.disconnectLaser()),
    );
    const status = el('p', 'bluetooth-help');
    status.dataset.targetBluetooth = '';
    status.setAttribute('role', 'status');
    page.append(controls, status);

    const setup = document.createElement('details');
    setup.className = 'target-setup';
    setup.open = true;
    setup.append(el('summary', '', 'Game setup'));
    const settings = document.createElement('form');
    settings.className = 'target-settings';
    const playerFieldset = document.createElement('fieldset');
    playerFieldset.className = 'target-players';
    playerFieldset.append(el('legend', '', 'Players'));
    const playerList = el('div', 'target-player-list');
    const addPlayer = button('Add player', 'button quiet compact', () => {
      if (playerList.children.length >= 8) return;
      addPlayerField('');
      playerList.lastElementChild?.querySelector<HTMLInputElement>('input')?.focus();
    });
    const addPlayerField = (name: string) => {
      const row = el('div', 'target-player-row');
      const label = document.createElement('label');
      label.className = 'field';
      const caption = el('span');
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 20;
      input.required = true;
      input.value = name;
      input.autocomplete = 'off';
      input.className = 'target-player-input';
      label.append(caption, input);
      const remove = button('Remove', 'button quiet compact', () => { row.remove(); refreshPlayers(); });
      remove.classList.add('target-remove-player');
      row.append(label, remove);
      playerList.append(row);
      refreshPlayers();
    };
    const refreshPlayers = () => {
      [...playerList.children].forEach((row, index) => {
        row.querySelector('label span')!.textContent = `Player ${index + 1}`;
        const remove = row.querySelector<HTMLButtonElement>('.target-remove-player')!;
        remove.disabled = playerList.children.length === 1;
        remove.setAttribute('aria-label', `Remove player ${index + 1}`);
      });
      addPlayer.disabled = playerList.children.length >= 8;
    };
    this.game.players.forEach(addPlayerField);
    playerFieldset.append(playerList, addPlayer);
    const minimumLabel = document.createElement('label');
    minimumLabel.className = 'field';
    minimumLabel.append(el('span', '', 'Minimum target (m)'));
    const minimum = document.createElement('input');
    minimum.type = 'number';
    minimum.min = '0.01';
    minimum.max = '100';
    minimum.step = '0.01';
    minimum.required = true;
    minimum.value = String(this.game.minimum);
    minimumLabel.append(minimum);
    const maximumLabel = document.createElement('label');
    maximumLabel.className = 'field';
    maximumLabel.append(el('span', '', 'Maximum target (m)'));
    const maximum = document.createElement('input');
    maximum.type = 'number';
    maximum.min = '0.01';
    maximum.max = '100';
    maximum.step = '0.01';
    maximum.required = true;
    maximum.value = String(this.game.maximum);
    maximumLabel.append(maximum);
    const roundsLabel = document.createElement('label');
    roundsLabel.className = 'field';
    roundsLabel.append(el('span', '', 'Rounds'));
    const rounds = document.createElement('input');
    rounds.type = 'number';
    rounds.min = '1';
    rounds.max = '20';
    rounds.step = '1';
    rounds.required = true;
    rounds.value = String(this.game.rounds);
    roundsLabel.append(rounds);
    const modeLabel = document.createElement('label');
    modeLabel.className = 'field target-mode-field';
    modeLabel.append(el('span', '', 'Game mode'));
    const mode = document.createElement('select');
    const modes: [TargetGameMode, string][] = [
      ['shared', 'Shared target each round'],
      ['individual', 'Different target each turn'],
      ['shuffled', 'Player by player, shuffled targets'],
      ['fixed', 'Same target all game'],
      ['ascending', 'Increasing targets'],
      ['descending', 'Decreasing targets'],
    ];
    modes.forEach(([value, text]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      mode.append(option);
    });
    mode.value = this.game.mode;
    modeLabel.append(mode);
    const start = document.createElement('button');
    start.type = 'submit';
    start.className = 'button quiet compact';
    start.textContent = 'New game';
    const setupFields = el('div', 'target-setup-fields');
    setupFields.append(modeLabel, minimumLabel, maximumLabel, roundsLabel, start);
    settings.append(playerFieldset, setupFields);
    settings.addEventListener('submit', (event) => {
      event.preventDefault();
      try {
        const names = [...playerList.querySelectorAll<HTMLInputElement>('.target-player-input')].map((input) => input.value);
        this.game = createTargetGame(names, Number(rounds.value), Number(minimum.value), Number(maximum.value), Math.random, mode.value as TargetGameMode);
      } catch (error) {
        this.toast(error instanceof Error ? error.message : 'The game settings are invalid.');
        return;
      }
      distance.value = '';
      setup.open = false;
      this.updateGame();
    });
    setup.append(settings);
    page.append(setup);

    const game = el('div', 'target-game');
    const targetArea = el('div', 'target-aim');
    const ring = el('div', 'target-ring');
    const center = el('div', 'target-center');
    center.append(el('span', 'target-label', 'Target'));
    const targetValue = el('strong');
    targetValue.dataset.targetValue = '';
    center.append(targetValue, el('span', 'target-unit', 'meters'));
    ring.append(center);
    targetArea.append(ring);
    const info = el('div', 'target-info');
    const progress = el('p', 'target-progress');
    progress.dataset.targetProgress = '';
    const player = el('p', 'target-player');
    player.dataset.targetPlayer = '';
    const score = el('p', 'target-total');
    score.dataset.targetTotal = '';
    const result = el('div', 'target-result');
    result.dataset.targetResult = '';
    result.setAttribute('role', 'status');
    const next = button('Next player', 'button primary compact', () => this.nextTurn());
    next.dataset.targetNext = '';
    const manual = document.createElement('form');
    manual.className = 'target-manual';
    const label = document.createElement('label');
    label.className = 'field';
    label.append(el('span', '', 'Distance (m)'));
    const distance = document.createElement('input');
    distance.type = 'number';
    distance.min = '0.001';
    distance.step = 'any';
    distance.required = true;
    distance.inputMode = 'decimal';
    label.append(distance);
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'button quiet compact';
    submit.textContent = 'Submit reading';
    manual.append(label, submit);
    manual.addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.addMeasurement({ valueMeters: Number(distance.value) })) distance.value = '';
    });
    info.append(progress, player, score, result, next, manual);
    game.append(targetArea, info);
    page.append(game, el('p', 'bluetooth-help', 'Aim the laser at a solid surface, never at eyes.'));

    const leaderboardHeading = el('h2', '', 'Leaderboard');
    const leaderboard = el('ol', 'target-leaderboard');
    leaderboard.dataset.targetLeaderboard = '';
    const historyHeading = el('h2', '', 'Rounds');
    const history = el('ol', 'target-history');
    history.dataset.targetHistory = '';
    page.append(leaderboardHeading, leaderboard, historyHeading, history);
    main.append(page);
    this.updateStatus();
    this.updateGame();
  }

  dispose(): void {
    void this.disconnectLaser();
    this.container = null;
  }

  addMeasurement(reading: Pick<ParsedMeasurement, 'valueMeters'>): boolean {
    if (this.game.awaitingNext || this.game.attempts.length >= this.game.players.length * this.game.rounds) return false;
    try {
      this.game = recordTargetAttempt(this.game, reading.valueMeters);
    } catch (error) {
      this.toast(error instanceof Error ? error.message : 'The measurement is invalid.');
      return false;
    }
    this.updateGame();
    return true;
  }

  private nextTurn(): void {
    this.game = advanceTargetTurn(this.game);
    this.updateGame();
  }

  private updateGame(): void {
    const target = this.container?.querySelector<HTMLElement>('[data-target-value]');
    const progress = this.container?.querySelector<HTMLElement>('[data-target-progress]');
    const player = this.container?.querySelector<HTMLElement>('[data-target-player]');
    const total = this.container?.querySelector<HTMLElement>('[data-target-total]');
    const result = this.container?.querySelector<HTMLElement>('[data-target-result]');
    const next = this.container?.querySelector<HTMLButtonElement>('[data-target-next]');
    const manual = this.container?.querySelector<HTMLFormElement>('.target-manual');
    const leaderboard = this.container?.querySelector<HTMLElement>('[data-target-leaderboard]');
    const history = this.container?.querySelector<HTMLElement>('[data-target-history]');
    if (!target || !progress || !player || !total || !result || !next || !manual || !leaderboard || !history) return;
    const { players, rounds, attempts, awaitingNext } = this.game;
    const finished = attempts.length >= players.length * rounds;
    const currentIndex = awaitingNext ? attempts.length - 1 : attempts.length;
    const { playerIndex, round: currentRound } = targetTurn(this.game, currentIndex);
    const totals = players.map((name, index) => ({ name, index, points: attempts.filter((attempt) => attempt.playerIndex === index).reduce((sum, attempt) => sum + attempt.points, 0) }));
    const leaders = [...totals].sort((left, right) => right.points - left.points);
    target.textContent = this.game.target.toFixed(2);
    progress.textContent = finished ? 'Game complete' : `Round ${currentRound} / ${rounds}`;
    player.textContent = finished ? `Winner${leaders.filter((item) => item.points === leaders[0].points).length > 1 ? 's' : ''}: ${leaders.filter((item) => item.points === leaders[0].points).map((item) => item.name).join(', ')}` : `${players[playerIndex]}'s ${awaitingNext ? 'result' : 'turn'}`;
    total.textContent = `${finished ? leaders[0].points : totals[playerIndex].points} / ${rounds * 100} points`;
    result.replaceChildren();
    const attempt = awaitingNext ? attempts[attempts.length - 1] : null;
    if (attempt) {
      const difference = Math.abs(attempt.differenceMeters * 100);
      const direction = difference < 0.05 ? 'On target' : attempt.differenceMeters < 0 ? 'Too short' : 'Too far';
      result.append(el('strong', '', `${players[attempt.playerIndex]}: ${attempt.points} points`), el('span', '', `${attempt.measuredMeters.toFixed(3)} m · ${difference.toFixed(1)} cm · ${direction}`));
    } else result.append(el('span', '', 'Waiting for a reading'));
    next.textContent = awaitingNext && !finished && targetTurn(this.game, attempts.length).playerIndex === playerIndex ? 'Next round'
      : awaitingNext && !finished && targetTurn(this.game, attempts.length).round !== currentRound && this.game.mode !== 'shuffled' ? 'Next round' : 'Next player';
    next.disabled = !awaitingNext || finished;
    next.hidden = finished;
    manual.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach((control) => { control.disabled = awaitingNext || finished; });
    leaderboard.replaceChildren();
    leaders.forEach((item) => {
      const row = el('li', 'target-leaderboard-row');
      row.append(el('span', '', item.name), el('strong', '', `${item.points} pts`));
      if (!finished && item.index === playerIndex) row.setAttribute('aria-current', 'true');
      leaderboard.append(row);
    });
    history.replaceChildren();
    if (!attempts.length) history.append(el('li', 'measurements-empty', 'No rounds yet.'));
    attempts.forEach((item) => {
      const row = el('li', 'target-history-row');
      row.append(el('span', '', `Round ${item.round} · ${players[item.playerIndex]} · ${item.targetMeters.toFixed(2)} m → ${item.measuredMeters.toFixed(3)} m`), el('strong', '', `${item.points} pts`));
      history.append(row);
    });
  }

  private updateStatus(): void {
    const status = this.container?.querySelector<HTMLElement>('[data-target-bluetooth]');
    if (status) status.textContent = `Bluetooth: ${this.state}${this.detail ? ` (${this.detail})` : ''}`;
  }

  private async connectLaser(): Promise<void> {
    const generation = this.connectionGeneration + 1;
    await this.disconnectLaser();
    if (generation !== this.connectionGeneration || !this.container) return;
    const profile = loadCustomBoschProfile(this.storage);
    const adapter = new BoschLaserMeasureAdapter(this.provider, profile ? [profile] : undefined);
    this.adapter = adapter;
    try {
      await adapter.connect(
        (reading) => { if (this.adapter === adapter) this.addMeasurement(reading); },
        (state, detail) => { if (this.adapter === adapter) { this.state = state; this.detail = detail ?? ''; this.updateStatus(); } },
      );
    } catch {
      if (this.adapter === adapter) this.updateStatus();
    } finally {
      if (generation !== this.connectionGeneration || this.adapter !== adapter) await adapter.disconnect();
    }
  }

  private async readCurrent(): Promise<void> {
    if (!this.adapter?.readCurrentMeasurement) { this.toast('Connect a laser first.'); return; }
    try {
      await this.adapter.readCurrentMeasurement();
    } catch (error) {
      this.toast(error instanceof Error ? error.message : 'The measurement could not be read.');
    }
  }

  private async disconnectLaser(): Promise<void> {
    this.connectionGeneration++;
    const adapter = this.adapter;
    this.adapter = null;
    this.state = 'ready';
    this.detail = '';
    this.updateStatus();
    await adapter?.disconnect();
  }
}