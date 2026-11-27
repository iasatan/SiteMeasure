export interface SpeedReading {
  id: string;
  distanceMeters: number;
  capturedAt: string;
}

export interface RadialSpeed {
  metersPerSecond: number;
  elapsedSeconds: number;
}

export function calculateRadialSpeed(first: SpeedReading, last: SpeedReading): RadialSpeed | null {
  const firstTime = Date.parse(first.capturedAt);
  const lastTime = Date.parse(last.capturedAt);
  if (!Number.isFinite(first.distanceMeters) || first.distanceMeters <= 0 || !Number.isFinite(last.distanceMeters) || last.distanceMeters <= 0 || !Number.isFinite(firstTime) || !Number.isFinite(lastTime) || lastTime <= firstTime) return null;
  const elapsedSeconds = (lastTime - firstTime) / 1000;
  return { metersPerSecond: (last.distanceMeters - first.distanceMeters) / elapsedSeconds, elapsedSeconds };
}

export function sortSpeedReadings(readings: readonly SpeedReading[]): SpeedReading[] {
  return [...readings].sort((first, second) => Date.parse(first.capturedAt) - Date.parse(second.capturedAt));
}