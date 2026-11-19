import { describe, expect, it } from 'vitest';
import { providerForEnvironment } from '../src/bluetooth/providers/select-bluetooth-provider';
import { validateBoschProfile, type BoschDeviceProfile } from '../src/bluetooth/profiles/bosch-device-profile';
import { MeasurementCapture } from '../src/bluetooth/measurement-capture';
import { createRoom } from '../src/domain/models';

const validProfile: BoschDeviceProfile = {
  profileId: 'test-profile',
  displayName: 'Test meter',
  namePrefixes: ['TEST'],
  serviceUuid: '0000ffe0-0000-1000-8000-00805f9b34fb',
  measurementCharacteristicUuid: '0000ffe1-0000-1000-8000-00805f9b34fb',
  parseMeasurement: () => null,
};

describe('Bluetooth provider selection', () => {
  it('prefers iOSWebBLE on iOS when the extension is present', () => {
    expect(providerForEnvironment({ isIOS: true, hasIOSWebBLE: true, hasNativeBluetooth: true }).id).toBe('ios-webble');
  });

  it('falls back to native Bluetooth outside iOS', () => {
    expect(providerForEnvironment({ isIOS: false, hasIOSWebBLE: false, hasNativeBluetooth: true }).id).toBe('native');
  });

  it('requires an extension on iOS without iOSWebBLE', () => {
    const provider = providerForEnvironment({ isIOS: true, hasIOSWebBLE: false, hasNativeBluetooth: false });
    expect(provider.id).toBe('unsupported');
    expect(provider.label).toBe('iOSWebBLE required');
  });
});

describe('Bosch profile validation', () => {
  it('accepts structurally complete profiles', () => {
    expect(() => validateBoschProfile(validProfile)).not.toThrow();
  });

  it('rejects unverified TODO protocol values', () => {
    expect(() => validateBoschProfile({ ...validProfile, serviceUuid: 'TODO_VERIFIED_SERVICE_UUID' })).toThrow(/verified BLE UUID/);
  });
});

describe('measurement capture', () => {
  it('keeps one unconfirmed value in confirmation mode', () => {
    const capture = new MeasurementCapture();
    const first = capture.receive({ valueMeters: 1.2, capturedAt: '2026-01-01T00:00:00.000Z', deviceName: 'Meter A' });
    const second = capture.receive({ valueMeters: 2.3, capturedAt: '2026-01-01T00:00:01.000Z', deviceName: 'Meter A' });
    expect(capture.list()).toEqual([{ ...second, sequence: 2 }]);
    expect(first.sequence).toBe(1);
  });

  it('queues rapid captures and assigns them only on confirmation', () => {
    const capture = new MeasurementCapture();
    const room = createRoom();
    capture.mode = 'rapid';
    const first = capture.receive({ valueMeters: 2.5, capturedAt: '2026-01-01T00:00:00.000Z', deviceName: 'Meter A' });
    const second = capture.receive({ valueMeters: 3.5, capturedAt: '2026-01-01T00:00:01.000Z', deviceName: 'Meter A' });
    expect(capture.list()).toHaveLength(2);

    const measurement = capture.confirm(first.id, room, 'other', room.id);
    expect(measurement?.valueMeters).toBe(2.5);
    expect(capture.list().map((item) => item.id)).toEqual([second.id]);
    expect(room.measurements).toHaveLength(1);
  });
});
