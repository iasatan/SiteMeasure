import { describe, expect, it } from 'vitest';
import { compassHeading, loadScanRecords, saveScanRecords, type ScanRecord } from '../src/scan/scan-records';

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
