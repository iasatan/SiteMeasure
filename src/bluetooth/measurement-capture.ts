import type { Measurement, Room } from '../domain/models';
import { createId } from '../domain/models';
import type { ParsedMeasurement } from './types';

export type CaptureMode = 'confirmation' | 'rapid';

export interface PendingCapture extends ParsedMeasurement {
  id: string;
  sequence: number;
}

export class MeasurementCapture {
  private sequence = 0;
  private queue: PendingCapture[] = [];
  mode: CaptureMode = 'confirmation';

  receive(measurement: ParsedMeasurement): PendingCapture {
    const pending = { ...measurement, id: createId(), sequence: ++this.sequence };
    if (this.mode === 'confirmation') this.queue = [pending];
    else this.queue.push(pending);
    return pending;
  }

  list(): PendingCapture[] {
    return this.queue.map((capture) => ({ ...capture }));
  }

  discard(id: string): void {
    this.queue = this.queue.filter((capture) => capture.id !== id);
  }

  confirm(id: string, room: Room, targetType: Measurement['targetType'], targetId: string): Measurement | null {
    const capture = this.queue.find((candidate) => candidate.id === id);
    if (!capture || !Number.isFinite(capture.valueMeters) || capture.valueMeters <= 0) return null;
    const measurement: Measurement = {
      id: capture.id,
      targetType,
      targetId,
      valueMeters: capture.valueMeters,
      capturedAt: capture.capturedAt,
      source: 'bluetooth',
      deviceName: capture.deviceName,
      simulated: capture.simulated,
    };
    room.measurements.push(measurement);
    this.discard(capture.id);
    return measurement;
  }
}
