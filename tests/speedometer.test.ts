import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculateRadialSpeed, sortSpeedReadings, type SpeedReading } from '../src/speedometer/speed-records';
import { SpeedometerPage } from '../src/speedometer/speedometer-page';
import { BoschLaserMeasureAdapter } from '../src/bluetooth/bosch-laser-measure-adapter';
import type { ParsedMeasurement } from '../src/bluetooth/types';
import { SiteMeasureApp } from '../src/app';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

const reading = (id: string, distanceMeters: number, capturedAt: string): SpeedReading => ({ id, distanceMeters, capturedAt });

describe('radial speed', () => {
  it('calculates speed and direction from distance change and milliseconds', () => {
    const first = reading('first', 10, '2026-01-01T12:00:00.000Z');
    expect(calculateRadialSpeed(first, reading('away', 13, '2026-01-01T12:00:01.500Z'))).toEqual({ metersPerSecond: 2, elapsedSeconds: 1.5 });
    expect(calculateRadialSpeed(first, reading('toward', 7, '2026-01-01T12:00:01.500Z'))?.metersPerSecond).toBe(-2);
    expect(calculateRadialSpeed(first, reading('still', 10, '2026-01-01T12:00:01.500Z'))?.metersPerSecond).toBe(0);
  });

  it('rejects invalid distances, timestamps, and non-positive intervals', () => {
    const first = reading('first', 10, '2026-01-01T12:00:00.000Z');
    expect(calculateRadialSpeed(first, reading('same', 8, first.capturedAt))).toBeNull();
    expect(calculateRadialSpeed(first, reading('earlier', 8, '2025-01-01T00:00:00Z'))).toBeNull();
    expect(calculateRadialSpeed(first, reading('invalid', 8, 'bad'))).toBeNull();
    expect(calculateRadialSpeed(first, reading('zero', 0, '2026-01-01T12:00:01Z'))).toBeNull();
    expect(calculateRadialSpeed(first, reading('infinite', Infinity, '2026-01-01T12:00:01Z'))).toBeNull();
  });

  it('sorts readings by timestamp without mutating the input', () => {
    const readings = [reading('later', 4, '2026-01-01T12:00:01Z'), reading('earlier', 5, '2026-01-01T12:00:00Z')];
    expect(sortSpeedReadings(readings).map((item) => item.id)).toEqual(['earlier', 'later']);
    expect(readings[0].id).toBe('later');
  });
});

describe('speedometer page', () => {
  it('adds timestamped readings, displays speeds, and persists removal', () => {
    localStorage.clear();
    const toast = vi.fn();
    const page = new SpeedometerPage(localStorage, toast, vi.fn());
    const main = document.createElement('main');
    page.render(main);
    const form = main.querySelector('form')!;
    const distance = form.querySelector<HTMLInputElement>('input[type=number]')!;
    const time = form.querySelector<HTMLInputElement>('input[type=datetime-local]')!;
    distance.value = '10';
    time.value = '2026-01-01T12:00:00.000';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    distance.value = '7';
    time.value = '2026-01-01T12:00:01.500';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(main.querySelector('[data-speed-latest]')?.textContent).toBe('2.00 m/s · 7.20 km/h · Moving toward');
    expect(main.querySelector('[data-speed-overall]')?.textContent).toBe('2.00 m/s · 7.20 km/h · Moving toward');
    expect(main.querySelectorAll('.speedometer-reading')).toHaveLength(2);
    const reloaded = new SpeedometerPage(localStorage, toast, vi.fn());
    reloaded.render(main);
    expect(main.querySelectorAll('.speedometer-reading')).toHaveLength(2);
    main.querySelector<HTMLButtonElement>('[aria-label="Remove reading 1"]')!.click();
    expect(main.querySelector('[data-speed-latest]')?.textContent).toBe('Awaiting two readings');
    expect(JSON.parse(localStorage.getItem('sitemeasure.speedometer.readings')!)).toHaveLength(1);
    reloaded.dispose();
    page.dispose();
  });

  it('rejects duplicate timestamps and leaves the view unchanged when storage fails', () => {
    localStorage.clear();
    const toast = vi.fn();
    const page = new SpeedometerPage(localStorage, toast, vi.fn());
    const main = document.createElement('main');
    page.render(main);
    expect(page.addMeasurement({ valueMeters: 3, capturedAt: '2026-01-01T12:00:00Z' })).toBe(true);
    expect(page.addMeasurement({ valueMeters: 4, capturedAt: '2026-01-01T12:00:00.000Z' })).toBe(false);
    expect(toast).toHaveBeenCalledWith('A reading already has that timestamp.');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
    expect(page.addMeasurement({ valueMeters: 4, capturedAt: '2026-01-01T12:00:01Z' })).toBe(false);
    expect(toast).toHaveBeenCalledWith('Could not save speedometer readings on this device.');
    expect(main.querySelectorAll('.speedometer-reading')).toHaveLength(1);
    page.dispose();
  });

  it('accepts laser callbacks and ignores readings after leaving the page', async () => {
    localStorage.clear();
    let receive!: (measurement: ParsedMeasurement) => void;
    let finishConnection!: () => void;
    const disconnect = vi.spyOn(BoschLaserMeasureAdapter.prototype, 'disconnect').mockResolvedValue();
    const connect = vi.spyOn(BoschLaserMeasureAdapter.prototype, 'connect').mockImplementation((onMeasurement, onState) => {
      receive = onMeasurement;
      onState('connected');
      return new Promise<void>((resolve) => { finishConnection = resolve; });
    });
    const page = new SpeedometerPage(localStorage, vi.fn(), vi.fn());
    const main = document.createElement('main');
    page.render(main);
    const pending = (page as unknown as { connectLaser(): Promise<void> }).connectLaser();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    receive({ valueMeters: 5, capturedAt: '2026-01-01T12:00:00Z', deviceName: 'Laser' });
    expect(main.querySelectorAll('.speedometer-reading')).toHaveLength(1);
    page.dispose();
    receive({ valueMeters: 6, capturedAt: '2026-01-01T12:00:01Z', deviceName: 'Laser' });
    finishConnection();
    await pending;
    expect(JSON.parse(localStorage.getItem('sitemeasure.speedometer.readings')!)).toHaveLength(1);
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it('does not open a laser connection after immediate navigation away', async () => {
    const connect = vi.spyOn(BoschLaserMeasureAdapter.prototype, 'connect').mockResolvedValue();
    const page = new SpeedometerPage(localStorage, vi.fn(), vi.fn());
    page.render(document.createElement('main'));
    const pending = (page as unknown as { connectLaser(): Promise<void> }).connectLaser();
    page.dispose();
    await pending;
    expect(connect).not.toHaveBeenCalled();
  });

  it('opens from Misc and cleans up when returning', () => {
    const originalUrl = window.location.pathname + window.location.search + window.location.hash;
    history.replaceState(null, '', '#misc');
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as { speedometerPage: SpeedometerPage };
    const dispose = vi.spyOn(app.speedometerPage, 'dispose');
    [...root.querySelectorAll<HTMLButtonElement>('.misc-feature-button')].find((item) => item.textContent?.startsWith('Speedometer'))!.click();
    expect(window.location.hash).toBe('#speedometer');
    expect(root.querySelector('.speedometer-page h1')?.textContent).toBe('Speedometer');
    expect([...root.querySelectorAll('.nav-item')].find((item) => item.textContent?.includes('Misc'))?.getAttribute('aria-current')).toBe('location');
    [...root.querySelectorAll<HTMLButtonElement>('.speedometer-page button')].find((item) => item.textContent === 'Back to Misc')!.click();
    expect(window.location.hash).toBe('#misc');
    expect(dispose).toHaveBeenCalledOnce();
    history.replaceState(null, '', originalUrl);
    root.remove();
  });
});