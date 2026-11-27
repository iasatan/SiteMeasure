import { BoschLaserMeasureAdapter } from '../bluetooth/bosch-laser-measure-adapter';
import { loadCustomBoschProfile } from '../bluetooth/custom-bosch-profile';
import { selectBluetoothProvider } from '../bluetooth/providers/select-bluetooth-provider';
import type { BluetoothConnectionState, LaserMeasureAdapter, ParsedMeasurement } from '../bluetooth/types';
import { createId } from '../domain/models';
import { calculateRadialSpeed, sortSpeedReadings, type SpeedReading } from './speed-records';

const STORAGE_KEY = 'sitemeasure.speedometer.readings';

function validReading(value: unknown): value is SpeedReading {
  if (!value || typeof value !== 'object') return false;
  const reading = value as Partial<SpeedReading>;
  return typeof reading.id === 'string' && typeof reading.distanceMeters === 'number' && Number.isFinite(reading.distanceMeters) && reading.distanceMeters > 0
    && typeof reading.capturedAt === 'string' && Number.isFinite(Date.parse(reading.capturedAt));
}

function loadReadings(storage: Storage): SpeedReading[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const times = new Set<number>();
    return sortSpeedReadings(parsed.filter(validReading).filter((reading) => {
      const time = Date.parse(reading.capturedAt);
      if (times.has(time)) return false;
      times.add(time);
      return true;
    }));
  } catch {
    return [];
  }
}

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

function localTimestamp(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 23);
}

function speedText(speed: number): string {
  const direction = speed > 0 ? 'Moving away' : speed < 0 ? 'Moving toward' : 'Stationary';
  return `${Math.abs(speed).toFixed(2)} m/s · ${(Math.abs(speed) * 3.6).toFixed(2)} km/h · ${direction}`;
}

export class SpeedometerPage {
  private readings: SpeedReading[];
  private container: HTMLElement | null = null;
  private adapter: LaserMeasureAdapter | null = null;
  private state: BluetoothConnectionState = 'ready';
  private detail = '';
  private connectionGeneration = 0;
  private readonly provider = selectBluetoothProvider();

  constructor(private readonly storage: Storage, private readonly toast: (message: string) => void, private readonly onBack: () => void) {
    this.readings = loadReadings(storage);
  }

  render(main: HTMLElement): void {
    this.container = main;
    main.replaceChildren();
    const page = el('section', 'page speedometer-page');
    const heading = el('div', 'page-heading');
    const title = el('div');
    title.append(el('p', 'eyebrow', 'Misc'), el('h1', '', 'Speedometer'));
    heading.append(title, button('Back to Misc', 'button quiet compact', this.onBack));
    page.append(heading);

    const controls = el('div', 'speedometer-controls');
    controls.append(
      button('Connect laser', 'button primary compact', () => void this.connectLaser()),
      button('Read current', 'button quiet compact', () => void this.readCurrent()),
      button('Disconnect', 'button quiet compact', () => void this.disconnectLaser()),
    );
    page.append(controls);
    const status = el('p', 'bluetooth-help');
    status.dataset.speedBluetooth = '';
    status.setAttribute('role', 'status');
    page.append(status);

    const summary = el('section', 'speedometer-summary');
    summary.setAttribute('aria-label', 'Radial speed');
    const latest = el('div', 'speedometer-metric');
    latest.append(el('span', '', 'Latest interval'));
    const latestValue = el('strong');
    latestValue.dataset.speedLatest = '';
    latestValue.setAttribute('aria-live', 'polite');
    latest.append(latestValue);
    const average = el('div', 'speedometer-metric');
    average.append(el('span', '', 'Overall radial speed'));
    const averageValue = el('strong');
    averageValue.dataset.speedOverall = '';
    average.append(averageValue);
    summary.append(latest, average);
    page.append(summary, el('p', 'bluetooth-help', 'Radial speed measures change in distance from a fixed laser. Sideways motion is not measured; device timing and measurement latency affect accuracy.'));

    const form = document.createElement('form');
    form.className = 'speedometer-form';
    const distanceLabel = document.createElement('label');
    distanceLabel.className = 'field';
    distanceLabel.append(el('span', '', 'Distance (m)'));
    const distance = document.createElement('input');
    distance.type = 'number';
    distance.min = '0.001';
    distance.step = 'any';
    distance.required = true;
    distance.inputMode = 'decimal';
    distanceLabel.append(distance);
    const timeLabel = document.createElement('label');
    timeLabel.className = 'field';
    timeLabel.append(el('span', '', 'Time'));
    const time = document.createElement('input');
    time.type = 'datetime-local';
    time.step = '0.001';
    time.required = true;
    time.value = localTimestamp();
    timeLabel.append(time);
    const add = document.createElement('button');
    add.type = 'submit';
    add.className = 'button primary compact';
    add.textContent = 'Add reading';
    form.append(distanceLabel, timeLabel, add);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const capturedTime = new Date(time.value).getTime();
      if (!Number.isFinite(capturedTime)) { this.toast('Enter a valid time.'); return; }
      if (this.addMeasurement({ valueMeters: Number(distance.value), capturedAt: new Date(capturedTime).toISOString() })) {
        distance.value = '';
        time.value = localTimestamp();
      }
    });
    page.append(form);

    const readingsHeading = el('div', 'speedometer-readings-heading');
    readingsHeading.append(el('h2', '', 'Readings'), button('Clear readings', 'button quiet compact', () => this.saveReadings([])));
    const list = el('ol', 'speedometer-readings');
    list.dataset.speedReadings = '';
    page.append(readingsHeading, list);
    main.append(page);
    this.updateStatus();
    this.updateReadings();
  }

  dispose(): void {
    void this.disconnectLaser();
    this.container = null;
  }

  addMeasurement(reading: Pick<ParsedMeasurement, 'valueMeters' | 'capturedAt'>): boolean {
    if (!Number.isFinite(reading.valueMeters) || reading.valueMeters <= 0 || !Number.isFinite(Date.parse(reading.capturedAt))) {
      this.toast('Enter a positive distance and a valid time.');
      return false;
    }
    if (this.readings.some((item) => Date.parse(item.capturedAt) === Date.parse(reading.capturedAt))) {
      this.toast('A reading already has that timestamp.');
      return false;
    }
    return this.saveReadings(sortSpeedReadings([...this.readings, { id: createId(), distanceMeters: reading.valueMeters, capturedAt: reading.capturedAt }]));
  }

  private saveReadings(readings: SpeedReading[]): boolean {
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(readings));
    } catch {
      this.toast('Could not save speedometer readings on this device.');
      return false;
    }
    this.readings = readings;
    this.updateReadings();
    return true;
  }

  private updateReadings(): void {
    const latest = this.container?.querySelector<HTMLElement>('[data-speed-latest]');
    const overall = this.container?.querySelector<HTMLElement>('[data-speed-overall]');
    const list = this.container?.querySelector<HTMLElement>('[data-speed-readings]');
    if (!latest || !overall || !list) return;
    const first = this.readings[0];
    const last = this.readings[this.readings.length - 1];
    const previous = this.readings[this.readings.length - 2];
    const latestSpeed = previous && last ? calculateRadialSpeed(previous, last) : null;
    const overallSpeed = first && last ? calculateRadialSpeed(first, last) : null;
    latest.textContent = latestSpeed ? speedText(latestSpeed.metersPerSecond) : 'Awaiting two readings';
    overall.textContent = overallSpeed ? speedText(overallSpeed.metersPerSecond) : 'Awaiting two readings';
    list.replaceChildren();
    if (!this.readings.length) list.append(el('li', 'measurements-empty', 'No readings yet.'));
    this.readings.forEach((reading, index) => {
      const row = el('li', 'speedometer-reading');
      const details = el('div');
      const timestamp = new Date(reading.capturedAt).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
      details.append(el('strong', '', `${reading.distanceMeters.toFixed(3)} m`), el('span', '', timestamp));
      const previousReading = this.readings[index - 1];
      const speed = previousReading ? calculateRadialSpeed(previousReading, reading) : null;
      if (speed) details.append(el('span', '', `${speedText(speed.metersPerSecond)} · ${speed.elapsedSeconds.toFixed(3)} s`));
      const remove = button('Remove', 'button quiet compact', () => this.saveReadings(this.readings.filter((item) => item.id !== reading.id)));
      remove.setAttribute('aria-label', `Remove reading ${index + 1}`);
      row.append(details, remove);
      list.append(row);
    });
  }

  private updateStatus(): void {
    const status = this.container?.querySelector<HTMLElement>('[data-speed-bluetooth]');
    if (status) status.textContent = `Bluetooth: ${this.state}${this.detail ? ` (${this.detail})` : ''}`;
  }

  private async connectLaser(): Promise<void> {
    const generation = this.connectionGeneration + 1;
    await this.disconnectLaser();
    if (generation !== this.connectionGeneration || !this.container) return;
    const customProfile = loadCustomBoschProfile(this.storage);
    const adapter = new BoschLaserMeasureAdapter(this.provider, customProfile ? [customProfile] : undefined);
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