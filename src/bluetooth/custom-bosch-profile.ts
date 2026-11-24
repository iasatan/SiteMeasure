import type { BoschDeviceProfile } from './profiles/bosch-device-profile';
import { validateBoschProfile } from './profiles/bosch-device-profile';
import type { ParsedMeasurement } from './types';

export const CUSTOM_BOSCH_PROFILE_STORAGE_KEY = 'sitemeasure:custom-bosch-profile';
const BOSCH_MEASUREMENT_CHARACTERISTIC_UUID = '02a6c0d2-0451-4000-b000-fb3210111989';

export type BoschPayloadFormat = 'bosch-glm20' | 'float32-le-m' | 'uint32-le-mm' | 'uint32-le-0.1mm' | 'uint16-le-mm';

export interface CustomBoschProfileSettings {
  displayName: string;
  namePrefix: string;
  serviceUuid: string;
  measurementCharacteristicUuid: string;
  payloadFormat: BoschPayloadFormat;
  byteOffset: number;
}

export function loadCustomBoschProfile(storage: Storage): BoschDeviceProfile | null {
  const raw = storage.getItem(CUSTOM_BOSCH_PROFILE_STORAGE_KEY);
  if (!raw) return null;
  try {
    const settings = JSON.parse(raw) as Partial<CustomBoschProfileSettings>;
    return createCustomBoschProfile(settings);
  } catch {
    return null;
  }
}

export function loadCustomBoschProfileSettings(storage: Storage): CustomBoschProfileSettings | null {
  const raw = storage.getItem(CUSTOM_BOSCH_PROFILE_STORAGE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as CustomBoschProfileSettings;
    if (value.measurementCharacteristicUuid?.toLowerCase() === BOSCH_MEASUREMENT_CHARACTERISTIC_UUID) value.payloadFormat = 'bosch-glm20';
    createCustomBoschProfile(value);
    return value;
  } catch {
    return null;
  }
}

export function saveCustomBoschProfile(storage: Storage, settings: CustomBoschProfileSettings): BoschDeviceProfile {
  const profile = createCustomBoschProfile(settings);
  storage.setItem(CUSTOM_BOSCH_PROFILE_STORAGE_KEY, JSON.stringify(settings));
  return profile;
}

export function clearCustomBoschProfile(storage: Storage): void {
  storage.removeItem(CUSTOM_BOSCH_PROFILE_STORAGE_KEY);
}

export function createCustomBoschProfile(value: Partial<CustomBoschProfileSettings>): BoschDeviceProfile {
  const measurementCharacteristicUuid = typeof value.measurementCharacteristicUuid === 'string' ? value.measurementCharacteristicUuid.trim().toLowerCase() : '';
  const requestedPayloadFormat = isPayloadFormat(value.payloadFormat) ? value.payloadFormat : 'float32-le-m';
  const settings: CustomBoschProfileSettings = {
    displayName: typeof value.displayName === 'string' ? value.displayName.trim() : '',
    namePrefix: typeof value.namePrefix === 'string' ? value.namePrefix.trim() : '',
    serviceUuid: typeof value.serviceUuid === 'string' ? value.serviceUuid.trim().toLowerCase() : '',
    measurementCharacteristicUuid,
    payloadFormat: measurementCharacteristicUuid === BOSCH_MEASUREMENT_CHARACTERISTIC_UUID ? 'bosch-glm20' : requestedPayloadFormat,
    byteOffset: Number.isInteger(value.byteOffset) && Number(value.byteOffset) >= 0 ? Number(value.byteOffset) : 0,
  };
  const profile: BoschDeviceProfile = {
    profileId: 'custom-bosch-device',
    displayName: settings.displayName,
    namePrefixes: [settings.namePrefix],
    serviceUuid: settings.serviceUuid,
    measurementCharacteristicUuid: settings.measurementCharacteristicUuid,
    commandCharacteristicUuid: settings.payloadFormat === 'bosch-glm20' ? settings.measurementCharacteristicUuid : undefined,
    setupCommand: settings.payloadFormat === 'bosch-glm20' ? new Uint8Array([0xc0, 0x55, 0x02, 0x01, 0x00, 0x1a]) : undefined,
    parseMeasurement: (data, context) => parseConfiguredMeasurement(data, settings, context),
  };
  validateBoschProfile(profile);
  return profile;
}

function parseConfiguredMeasurement(value: DataView, settings: CustomBoschProfileSettings, context: { deviceName: string; receivedAt: string }): ParsedMeasurement | null {
  let meters: number;
  try {
    switch (settings.payloadFormat) {
      case 'bosch-glm20':
        if (value.byteLength < 20 || value.getUint8(0) !== 0xc0 || value.getUint8(1) !== 0x55 || value.getUint8(2) !== 0x10) return null;
        meters = value.getFloat32(7, true);
        break;
      case 'float32-le-m':
        meters = value.getFloat32(settings.byteOffset, true);
        break;
      case 'uint32-le-mm':
        meters = value.getUint32(settings.byteOffset, true) / 1000;
        break;
      case 'uint32-le-0.1mm':
        meters = value.getUint32(settings.byteOffset, true) / 10_000;
        break;
      case 'uint16-le-mm':
        meters = value.getUint16(settings.byteOffset, true) / 1000;
        break;
    }
  } catch {
    return null;
  }
  if (!Number.isFinite(meters) || meters <= 0 || meters > 1_000_000) return null;
  return { valueMeters: meters, capturedAt: context.receivedAt, deviceName: context.deviceName };
}

function isPayloadFormat(value: unknown): value is BoschPayloadFormat {
  return value === 'bosch-glm20' || value === 'float32-le-m' || value === 'uint32-le-mm' || value === 'uint32-le-0.1mm' || value === 'uint16-le-mm';
}
