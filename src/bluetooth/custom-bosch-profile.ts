import type { BoschDeviceProfile } from './profiles/bosch-device-profile';
import { validateBoschProfile } from './profiles/bosch-device-profile';
import type { ParsedMeasurement } from './types';

export const CUSTOM_BOSCH_PROFILE_STORAGE_KEY = 'sitemeasure:custom-bosch-profile';

export type BoschPayloadFormat = 'float32-le-m' | 'uint32-le-mm' | 'uint32-le-0.1mm' | 'uint16-le-mm';

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
  const settings: CustomBoschProfileSettings = {
    displayName: typeof value.displayName === 'string' ? value.displayName.trim() : '',
    namePrefix: typeof value.namePrefix === 'string' ? value.namePrefix.trim() : '',
    serviceUuid: typeof value.serviceUuid === 'string' ? value.serviceUuid.trim().toLowerCase() : '',
    measurementCharacteristicUuid: typeof value.measurementCharacteristicUuid === 'string' ? value.measurementCharacteristicUuid.trim().toLowerCase() : '',
    payloadFormat: isPayloadFormat(value.payloadFormat) ? value.payloadFormat : 'float32-le-m',
    byteOffset: Number.isInteger(value.byteOffset) && Number(value.byteOffset) >= 0 ? Number(value.byteOffset) : 0,
  };
  const profile: BoschDeviceProfile = {
    profileId: 'custom-bosch-device',
    displayName: settings.displayName,
    namePrefixes: [settings.namePrefix],
    serviceUuid: settings.serviceUuid,
    measurementCharacteristicUuid: settings.measurementCharacteristicUuid,
    parseMeasurement: (data, context) => parseConfiguredMeasurement(data, settings, context),
  };
  validateBoschProfile(profile);
  return profile;
}

function parseConfiguredMeasurement(value: DataView, settings: CustomBoschProfileSettings, context: { deviceName: string; receivedAt: string }): ParsedMeasurement | null {
  let meters: number;
  try {
    switch (settings.payloadFormat) {
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
  return value === 'float32-le-m' || value === 'uint32-le-mm' || value === 'uint32-le-0.1mm' || value === 'uint16-le-mm';
}
