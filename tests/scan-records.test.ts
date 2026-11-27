import { describe, expect, it } from 'vitest';
import { compassHeading, loadScanRecords, saveScanRecords, type ScanRecord } from '../src/scan/scan-records';
import { buildScanGeometry } from '../src/scan/scan-geometry';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
}

describe('scan records', () => {
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
});
