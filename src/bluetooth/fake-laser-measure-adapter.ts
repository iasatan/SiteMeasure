import type { BluetoothConnectionState, LaserMeasureAdapter, ParsedMeasurement } from './types';

export class FakeLaserMeasureAdapter implements LaserMeasureAdapter {
  readonly providerId = 'fake' as const;
  deviceName: string | null = null;
  private onMeasurement: ((measurement: ParsedMeasurement) => void) | null = null;
  private onState: ((state: BluetoothConnectionState, detail?: string) => void) | null = null;
  private connected = false;
  private demoSequence = 0;

  async connect(
    onMeasurement: (measurement: ParsedMeasurement) => void,
    onState: (state: BluetoothConnectionState, detail?: string) => void,
  ): Promise<void> {
    this.onMeasurement = onMeasurement;
    this.onState = onState;
    this.deviceName = 'SiteMeasure demo meter (simulated)';
    onState('connecting');
    this.connected = true;
    onState('connected');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.onState?.('disconnected');
    this.onMeasurement = null;
    this.onState = null;
    this.deviceName = null;
  }

  emitDemoMeasurement(valueMeters = 2.45 + this.demoSequence * 0.125): void {
    if (!this.connected) throw new Error('Connect the simulated device first.');
    this.demoSequence += 1;
    this.onState?.('receiving');
    this.onMeasurement?.({
      valueMeters,
      capturedAt: new Date().toISOString(),
      deviceName: this.deviceName ?? 'Simulated laser meter',
      simulated: true,
    });
    this.onState?.('connected');
  }
}
