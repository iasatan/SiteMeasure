import type { BluetoothUuidLike, MeasurementParserContext, ParsedMeasurement } from '../types';

export interface BoschDeviceProfile {
  profileId: string;
  displayName: string;
  namePrefixes: string[];
  serviceUuid: BluetoothUuidLike;
  measurementCharacteristicUuid: BluetoothUuidLike;
  commandCharacteristicUuid?: BluetoothUuidLike;
  protocolVersion?: string;
  parseMeasurement(value: DataView, context: MeasurementParserContext): ParsedMeasurement | null;
}

const uuidPattern = /^(?:[0-9a-f]{4}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function validateBoschProfile(profile: BoschDeviceProfile): void {
  const uuidValues = [profile.serviceUuid, profile.measurementCharacteristicUuid, profile.commandCharacteristicUuid].filter((value): value is BluetoothUuidLike => value !== undefined);
  if (!profile.profileId.trim() || !profile.displayName.trim() || profile.namePrefixes.length === 0) throw new Error('Bosch device profile metadata is incomplete.');
  if (uuidValues.some((value) => typeof value !== 'number' && (value.startsWith('TODO') || !uuidPattern.test(value)))) {
    throw new Error(`Bosch profile ${profile.profileId} does not contain a verified BLE UUID.`);
  }
  if (profile.namePrefixes.some((prefix) => !prefix.trim() || prefix.startsWith('TODO'))) {
    throw new Error(`Bosch profile ${profile.profileId} does not contain verified device identifiers.`);
  }
}

export const BOSCH_PROFILE_BACKLOG = {
  profileId: 'bosch-device-unverified',
  displayName: 'Bosch laser measure',
  namePrefixes: ['TODO_VERIFIED_DEVICE_IDENTIFIER'],
  serviceUuid: 'TODO_VERIFIED_SERVICE_UUID',
  measurementCharacteristicUuid: 'TODO_VERIFIED_MEASUREMENT_CHARACTERISTIC_UUID',
  commandCharacteristicUuid: 'TODO_VERIFIED_COMMAND_CHARACTERISTIC_UUID',
} as const;

export const verifiedBoschProfiles: readonly BoschDeviceProfile[] = [];
