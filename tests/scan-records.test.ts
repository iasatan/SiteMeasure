import { describe, expect, it, vi } from 'vitest';
import { compassHeading, loadScanRecords, parseScanRecords, saveScanRecords, type ScanRecord } from '../src/scan/scan-records';
import { buildScanGeometry } from '../src/scan/scan-geometry';
import { ScanPage } from '../src/scan/scan-page';
import { SiteMeasureApp } from '../src/app';

vi.mock('../src/scan/scan-preview', () => ({
  createScanPreview: () => ({ setScan: (records: ScanRecord[]) => ({ count: records.length, triangles: 0 }), dispose: () => {} }),
}));

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
}

describe('scan records', () => {
  it('navigates between Misc and Scan and cleans up the scan page', () => {
    const originalUrl = window.location.pathname + window.location.search + window.location.hash;
    history.replaceState(null, '', '#misc');
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as { scanPage: ScanPage };
    const dispose = vi.spyOn(app.scanPage, 'dispose');
    expect(root.querySelector('.misc-page h1')?.textContent).toBe('Misc');
    expect([...root.querySelectorAll('.misc-feature-list button')].map((item) => item.textContent)).toEqual(['Scan→', 'Speedometer→', 'Target Practice→']);
    root.querySelector<HTMLButtonElement>('.misc-feature-list button')!.click();
    expect(window.location.hash).toBe('#scan');
    expect(root.querySelector('.scan-page h1')?.textContent).toBe('Scan');
    expect([...root.querySelectorAll('.nav-item')].find((item) => item.textContent?.includes('Misc'))?.getAttribute('aria-current')).toBe('location');
    [...root.querySelectorAll<HTMLButtonElement>('.scan-page button')].find((item) => item.textContent === 'Back to Misc')!.click();
    expect(window.location.hash).toBe('#misc');
    expect(root.querySelector('.misc-page h1')?.textContent).toBe('Misc');
    expect(dispose).toHaveBeenCalledOnce();
    history.replaceState(null, '', originalUrl);
    root.remove();
  });
  it('derives the compass heading from iOS or absolute Android events', () => {
    expect(compassHeading({ alpha: 10, absolute: false, webkitCompassHeading: 123 })).toBe(123);
    expect(compassHeading({ alpha: 90, absolute: true })).toBe(270);
    expect(compassHeading({ alpha: 90, absolute: false })).toBeNull();
  });

  it('round-trips records and ignores malformed entries', () => {
    const storage = memoryStorage();
    const record: ScanRecord = { id: 'a', capturedAt: '2026-01-01T00:00:00Z', distanceMeters: 2.5, orientation: { levelBeta: 1, levelGamma: -2, compassDegrees: null } };
    saveScanRecords(storage, [record]);
    expect(loadScanRecords(storage)).toEqual([record]);
    storage.setItem('sitemeasure.scan.records', JSON.stringify([record, { id: 1 }]));
    expect(loadScanRecords(storage)).toEqual([record]);
  });

  it('accepts exported scan arrays and rejects partially invalid files', () => {
    const record: ScanRecord = { id: 'a', capturedAt: '2026-01-01T00:00:00Z', distanceMeters: 2.5, orientation: { levelBeta: 1, levelGamma: -2, compassDegrees: null } };
    expect(parseScanRecords(JSON.stringify([record]))).toEqual([record]);
    expect(parseScanRecords('[]')).toEqual([]);
    expect(() => parseScanRecords('{bad')).toThrow('not valid JSON');
    expect(() => parseScanRecords(JSON.stringify([record, { id: 'bad' }]))).toThrow('not a valid scan record list');
    expect(() => parseScanRecords('{"projects":[]}')).toThrow('not a valid scan record list');
    expect(() => parseScanRecords('[{"id":"a","capturedAt":"","distanceMeters":1e400,"orientation":{"levelBeta":0,"levelGamma":0,"compassDegrees":0}}]')).toThrow('not a valid scan record list');
  });

  it('imports scans from the picker without duplicating or replacing existing records', async () => {
    const storage = memoryStorage();
    const existing: ScanRecord = { id: 'existing', capturedAt: '', distanceMeters: 3, orientation: { levelBeta: 1, levelGamma: 2, compassDegrees: 180 } };
    const imported = { ...existing, id: 'new', distanceMeters: 4 };
    saveScanRecords(storage, [existing]);
    const toast = vi.fn();
    const page = new ScanPage(storage as Storage, toast, vi.fn());
    const main = document.createElement('main');
    page.render(main);
    expect([...main.querySelectorAll('.project-tools')].map((group) => [...group.querySelectorAll('button')].map((item) => item.textContent))).toEqual([
      ['Enable sensors', 'Connect laser', 'Disconnect'],
      ['Import JSON', 'Download JSON', 'Clear list'],
    ]);
    const input = main.querySelector<HTMLInputElement>('input[type=file]')!;
    const file = new File([], 'scan.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(JSON.stringify([existing, imported, imported])) });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Imported 1 scan reading; 2 already present.'));
    expect(loadScanRecords(storage)).toEqual([existing, imported]);
    expect(main.querySelectorAll('.scan-list p')).toHaveLength(2);
    expect(main.querySelector('[data-scan-preview-status]')?.textContent).toBe('2 usable points');
    page.dispose();
  });

  it('keeps existing scans when import validation or saving fails', async () => {
    const storage = memoryStorage();
    const existing: ScanRecord = { id: 'existing', capturedAt: '', distanceMeters: 3, orientation: { levelBeta: 1, levelGamma: 2, compassDegrees: 180 } };
    saveScanRecords(storage, [existing]);
    const toast = vi.fn();
    const page = new ScanPage(storage as Storage, toast, vi.fn());
    const main = document.createElement('main');
    page.render(main);
    const input = main.querySelector<HTMLInputElement>('input[type=file]')!;
    const invalid = new File([], 'invalid.json');
    Object.defineProperty(invalid, 'text', { value: () => Promise.resolve(JSON.stringify([existing, { id: 'invalid' }])) });
    Object.defineProperty(input, 'files', { configurable: true, value: [invalid] });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('The file is not a valid scan record list.'));
    expect(loadScanRecords(storage)).toEqual([existing]);
    const valid = new File([], 'valid.json');
    Object.defineProperty(valid, 'text', { value: () => Promise.resolve(JSON.stringify([{ ...existing, id: 'new' }])) });
    Object.defineProperty(input, 'files', { configurable: true, value: [valid] });
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Storage full'));
    expect(loadScanRecords(storage)).toEqual([existing]);
    expect(main.querySelectorAll('.scan-list p')).toHaveLength(1);
    page.dispose();
  });
});

describe('scan geometry', () => {
  const record = (heading: number | null, elevation: number, distance = 5): ScanRecord => ({ id: String(heading), capturedAt: '', distanceMeters: distance, orientation: { levelBeta: elevation, levelGamma: 0, compassDegrees: heading } });

  it('projects compass and elevation to a 3D point and skips missing headings', () => {
    const result = buildScanGeometry([record(90, 0, 2), record(null, 0)], 'points');
    expect(result.count).toBe(1);
    const positions = result.geometry.getAttribute('position');
    expect(positions.getX(0)).toBeCloseTo(2);
    expect(positions.getY(0)).toBeCloseTo(0);
    expect(positions.getZ(0)).toBeCloseTo(0);
  });

  it('triangulates across north and smooths nearby distance readings', () => {
    const records = [record(359, 20, 4), record(1, 20, 6), record(0, 22, 5)];
    const surface = buildScanGeometry(records, 'surface');
    const smooth = buildScanGeometry(records, 'smooth');
    expect(surface.triangles).toBe(1);
    expect(smooth.triangles).toBe(1);
    expect(smooth.geometry.getAttribute('position').getY(0)).toBeGreaterThan(surface.geometry.getAttribute('position').getY(0));
  });

  it('does not invent triangles from collinear or duplicate directions', () => {
    expect(buildScanGeometry([record(0, 0), record(0, 0), record(0, 1)], 'surface').triangles).toBe(0);
  });

  it('connects interior readings with nearby points in both surface modes', () => {
    const records = [0, 5, 10].flatMap((elevation) => [220, 225, 230].map((heading) => record(heading, elevation, 4)));
    for (const mode of ['surface', 'smooth'] as const) {
      const { geometry, triangles } = buildScanGeometry(records, mode);
      const indices = Array.from(geometry.getIndex()!.array);
      expect(triangles).toBe(8);
      expect(new Set(indices).size).toBe(9);
      for (let index = 0; index < indices.length; index += 3) {
        const face = indices.slice(index, index + 3);
        for (let edge = 0; edge < 3; edge++) {
          const first = records[face[edge]].orientation;
          const second = records[face[(edge + 1) % 3]].orientation;
          expect(Math.abs(first.compassDegrees! - second.compassDegrees!)).toBeLessThanOrEqual(5);
          expect(Math.abs(first.levelBeta - second.levelBeta)).toBeLessThanOrEqual(5);
        }
      }
    }
  });

  it('creates a surface from the sample scan including repeated directions', () => {
    const readings = [[5.009, 21, 309], [5.099, 19.8, 307], [4.035, 18.7, 312], [5.041, 19, 306], [5.128, 21.6, 307], [4.970, 23.3, 311], [5.131, 24.6, 309], [5.242, 25.5, 308], [5.270, 25.5, 308], [5.363, 26, 307], [5.302, 26.7, 306], [5.275, 26.7, 309]];
    const records = readings.map(([distance, elevation, heading]) => record(heading, elevation, distance));
    for (const mode of ['surface', 'smooth'] as const) {
      const result = buildScanGeometry(records, mode);
      expect(result.count).toBe(12);
      expect(result.triangles).toBeGreaterThan(0);
      expect(Array.from(result.geometry.getAttribute('position').array).every(Number.isFinite)).toBe(true);
    }
  });

  it('connects all distinct directions in the larger scan', () => {
    const readings = [
      [4.340, 43.2, 222], [4.207, 40.4, 222], [3.933, 41.6, 233], [4.271, 39.9, 238], [4.202, 39.9, 247], [3.726, 40.0, 254], [3.752, 39.7, 261], [3.847, 39.2, 267], [4.060, 38.0, 275],
      [3.870, 33.4, 274], [3.772, 33.9, 270], [3.661, 34.0, 261], [3.596, 34.2, 255], [3.599, 33.8, 251], [4.053, 33.6, 248], [4.082, 32.9, 243], [4.180, 32.6, 234], [3.756, 33.2, 232], [4.072, 32.4, 222],
      [3.990, 28.0, 222], [3.657, 28.8, 232], [4.076, 28.2, 234], [3.925, 28.2, 248], [3.476, 28.5, 250], [3.544, 28.0, 261], [3.817, 27.2, 274], [3.769, 21.0, 274], [3.542, 21.4, 266], [3.435, 20.7, 259],
      [3.773, 20.5, 248], [3.978, 20.1, 235], [3.675, 20.5, 228], [3.862, 16.7, 223], [3.986, 13.1, 223], [4.023, 13.6, 229], [3.949, 14.6, 234], [3.756, 15.2, 247], [3.414, 14.7, 260], [3.744, 28.1, 269],
      [3.593, 16.0, 269], [3.448, 16.6, 262], [3.755, 19.8, 227], [3.561, 22.7, 216], [3.751, 32.1, 216], [2.946, 30.0, 206], [2.853, 20.2, 207], [2.935, 37.5, 201], [2.492, 34.7, 192], [2.291, 22.2, 191],
      [2.199, 30.6, 181], [2.250, 40.6, 172], [1.964, 24.7, 164], [4.089, 30.9, 241], [3.792, 0.8, 245], [3.547, 0.2, 262], [3.736, 2.5, 272],
    ];
    const records = readings.map(([distance, elevation, heading]) => record(heading, elevation, distance));
    for (const mode of ['surface', 'smooth'] as const) {
      const { geometry, count } = buildScanGeometry(records, mode);
      expect(count).toBe(56);
      expect(new Set(geometry.getIndex()!.array).size).toBe(56);
    }
  });
});
