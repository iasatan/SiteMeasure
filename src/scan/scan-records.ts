export interface ScanOrientation {
  /** Front/back tilt in degrees; 0 when the phone lies flat. */
  levelBeta: number;
  /** Left/right tilt in degrees; 0 when the phone lies flat. */
  levelGamma: number;
  /** Compass heading in degrees clockwise from north, or null when unavailable. */
  compassDegrees: number | null;
}

export interface ScanRecord {
  id: string;
  capturedAt: string;
  orientation: ScanOrientation;
  distanceMeters: number;
}

const STORAGE_KEY = 'sitemeasure.scan.records';

export function compassHeading(event: Pick<DeviceOrientationEvent, 'alpha' | 'absolute'> & { webkitCompassHeading?: number }): number | null {
  if (typeof event.webkitCompassHeading === 'number' && Number.isFinite(event.webkitCompassHeading)) return event.webkitCompassHeading;
  if (event.absolute && typeof event.alpha === 'number') return (360 - event.alpha) % 360;
  return null;
}

export function orientationFromEvent(event: DeviceOrientationEvent & { webkitCompassHeading?: number }): ScanOrientation | null {
  if (typeof event.beta !== 'number' || typeof event.gamma !== 'number') return null;
  return { levelBeta: event.beta, levelGamma: event.gamma, compassDegrees: compassHeading(event) };
}

export function loadScanRecords(storage: Pick<Storage, 'getItem'>): ScanRecord[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isScanRecord) : [];
  } catch {
    return [];
  }
}

export function saveScanRecords(storage: Pick<Storage, 'setItem'>, records: readonly ScanRecord[]): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(records));
}

export function parseScanRecords(text: string): ScanRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The scan file is not valid JSON.');
  }
  if (!Array.isArray(parsed) || !parsed.every(isScanRecord)) throw new Error('The file is not a valid scan record list.');
  return parsed;
}

function isScanRecord(value: unknown): value is ScanRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ScanRecord>;
  const orientation = record.orientation;
  return typeof record.id === 'string'
    && typeof record.capturedAt === 'string'
    && typeof record.distanceMeters === 'number' && Number.isFinite(record.distanceMeters)
    && !!orientation
    && typeof orientation.levelBeta === 'number' && Number.isFinite(orientation.levelBeta)
    && typeof orientation.levelGamma === 'number' && Number.isFinite(orientation.levelGamma)
    && (orientation.compassDegrees === null || (typeof orientation.compassDegrees === 'number' && Number.isFinite(orientation.compassDegrees)));
}
