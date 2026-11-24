import { describe, expect, it } from 'vitest';
import { providerForEnvironment } from '../src/bluetooth/providers/select-bluetooth-provider';
import { validateBoschProfile, type BoschDeviceProfile } from '../src/bluetooth/profiles/bosch-device-profile';
import { createCustomBoschProfile, loadCustomBoschProfileSettings, saveCustomBoschProfile } from '../src/bluetooth/custom-bosch-profile';
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

describe('custom Bosch profiles', () => {
  it('persists a configurable profile and decodes its measurement payload', () => {
    const settings = {
      displayName: 'My Bosch GLM',
      namePrefix: 'Bosch GLM',
      serviceUuid: '0000ffe0-0000-1000-8000-00805f9b34fb',
      measurementCharacteristicUuid: '0000ffe1-0000-1000-8000-00805f9b34fb',
      payloadFormat: 'float32-le-m' as const,
      byteOffset: 1,
    };
    saveCustomBoschProfile(localStorage, settings);
    expect(loadCustomBoschProfileSettings(localStorage)).toEqual(settings);
    const profile = createCustomBoschProfile(settings);
    const bytes = new Uint8Array([99, 0, 0, 0, 0]);
    new DataView(bytes.buffer).setFloat32(1, 2.45, true);
    expect(profile.parseMeasurement(new DataView(bytes.buffer), { deviceName: 'Bosch GLM', receivedAt: '2026-01-01T00:00:00.000Z' })?.valueMeters).toBeCloseTo(2.45);
  });

  it('decodes a Bosch GLM logging packet current value', () => {
    const profile = createCustomBoschProfile({
      displayName: 'Bosch GLM',
      namePrefix: 'GLM100-',
      serviceUuid: 'fde8',
      measurementCharacteristicUuid: '02a6c0d2-0451-4000-b000-fb3210111989',
      payloadFormat: 'bosch-glm20',
      byteOffset: 0,
    });
    const packet = new Uint8Array([0xc0, 0x55, 0x10, 0x0a, 0x08, 0x6a, 0x00, 0xdc, 0xd7, 0xc1, 0x3f, 0x4e, 0xd1, 0xc1, 0x3f, 0xc6, 0xdc, 0xc1, 0x3f, 0x3c]);
    expect(profile.parseMeasurement(new DataView(packet.buffer), { deviceName: 'GLM100-test', receivedAt: '2026-01-01T00:00:00.000Z' })?.valueMeters).toBeCloseTo(1.5144, 5);
    expect(profile.setupCommand).toEqual(new Uint8Array([0xc0, 0x55, 0x02, 0x01, 0x00, 0x1a]));
  });

  it('rejects incomplete device identifiers and UUIDs', () => {
    expect(() => createCustomBoschProfile({ displayName: '', namePrefix: '', serviceUuid: 'TODO', measurementCharacteristicUuid: '' })).toThrow();
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
