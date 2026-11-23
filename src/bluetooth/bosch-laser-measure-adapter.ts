import type { BoschDeviceProfile } from './profiles/bosch-device-profile';
import { validateBoschProfile, verifiedBoschProfiles } from './profiles/bosch-device-profile';
import type {
  BluetoothCharacteristicLike,
  BluetoothConnectionState,
  BluetoothDeviceLike,
  BluetoothProvider,
  LaserMeasureAdapter,
  ParsedMeasurement,
} from './types';

export class BoschLaserMeasureAdapter implements LaserMeasureAdapter {
  readonly providerId: BluetoothProvider['id'];
  deviceName: string | null = null;
  private device: BluetoothDeviceLike | null = null;
  private characteristic: BluetoothCharacteristicLike | null = null;
  private notificationHandler: ((event: Event) => void) | null = null;
  private onMeasurement: ((measurement: ParsedMeasurement) => void) | null = null;
  private onState: ((state: BluetoothConnectionState, detail?: string) => void) | null = null;
  private profile: BoschDeviceProfile | null = null;

  constructor(
    private readonly provider: BluetoothProvider,
    private readonly profiles: readonly BoschDeviceProfile[] = verifiedBoschProfiles,
  ) {
    this.providerId = provider.id;
  }

  async connect(
    onMeasurement: (measurement: ParsedMeasurement) => void,
    onState: (state: BluetoothConnectionState, detail?: string) => void,
  ): Promise<void> {
    try {
      if (!(await this.provider.isAvailable())) throw new Error(this.provider.id === 'unsupported' ? 'Bluetooth is not available here.' : 'Bluetooth provider is unavailable.');
      this.profiles.forEach(validateBoschProfile);
      if (this.profiles.length === 0) throw new Error('No Bosch device profile is configured. Open More > Bluetooth setup or choose Configure device below, then enter the BLE identifiers supplied for your measurer.');

      onState('searching');
      const device = await this.provider.requestDevice({
        filters: this.profiles.map((profile) => ({ services: [profile.serviceUuid], namePrefix: profile.namePrefixes[0] })),
        optionalServices: this.profiles.map((profile) => profile.serviceUuid),
      });
      const profile = this.profiles.find((candidate) => candidate.namePrefixes.some((prefix) => device.name?.startsWith(prefix)));
      if (!profile) throw new Error('The selected device does not match a verified Bosch profile.');
      if (!device.gatt) throw new Error('The selected device did not expose a Bluetooth GATT server.');

      onState('connecting');
      this.device = device;
      this.deviceName = device.name || profile.displayName;
      this.onMeasurement = onMeasurement;
      this.onState = onState;
      this.profile = profile;
      const server = await device.gatt.connect();
      let service;
      try {
        service = await server.getPrimaryService(profile.serviceUuid);
      } catch (error) {
        throw new Error(`GATT service ${profile.serviceUuid} could not be opened: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      let characteristic: BluetoothCharacteristicLike;
      try {
        characteristic = await service.getCharacteristic(profile.measurementCharacteristicUuid);
      } catch (error) {
        throw new Error(`GATT characteristic ${profile.measurementCharacteristicUuid} could not be opened: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      let notificationWarning = '';
      try {
        this.characteristic = await characteristic.startNotifications();
      } catch (error) {
        if (!characteristic.readValue) throw new Error(`GATT notifications could not be started: ${error instanceof Error ? error.message : 'unknown error'}`);
        this.characteristic = characteristic;
        notificationWarning = `Notifications unavailable; use Read current measurement. ${error instanceof Error ? error.message : ''}`.trim();
      }
      this.notificationHandler = (event) => {
        const eventCharacteristic = event.target as BluetoothCharacteristicLike | null;
        const value = eventCharacteristic?.value ?? this.characteristic?.value;
        if (!value) {
          onState('connected', 'Notification received, but iOSWebBLE did not expose a measurement payload.');
          return;
        }
        this.handleMeasurementValue(value);
      };
      this.characteristic.addEventListener('characteristicvaluechanged', this.notificationHandler);
      device.addEventListener('gattserverdisconnected', () => {
        onState('disconnected');
        this.deviceName = null;
      }, { once: true });
      onState('connected', notificationWarning);
    } catch (error) {
      onState('error', error instanceof Error ? error.message : 'The laser measure could not be connected.');
      throw error;
    }
  }

  async readCurrentMeasurement(): Promise<void> {
    if (!this.characteristic?.readValue) throw new Error('The selected characteristic does not support direct reading.');
    const value = await this.characteristic.readValue();
    this.handleMeasurementValue(value);
  }

  private handleMeasurementValue(value: DataView): void {
    if (!this.profile || !this.onMeasurement || !this.onState) return;
    const receivedAt = new Date().toISOString();
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const hex = Array.from(bytes.slice(0, 24), (byte) => byte.toString(16).padStart(2, '0')).join(' ');
    const suffix = bytes.length > 24 ? ' ...' : '';
    const packetDetail = `Received ${bytes.length} bytes: ${hex}${suffix}`;
    this.onState('receiving', packetDetail);
    const parsed = this.profile.parseMeasurement(value, { deviceName: this.deviceName ?? this.profile.displayName, receivedAt });
    if (parsed) {
      this.onMeasurement(parsed);
      this.onState('connected', packetDetail);
      return;
    }
    this.onState('connected', `${packetDetail}; the configured payload format could not decode them.`);
  }

  async disconnect(): Promise<void> {
    if (this.characteristic && this.notificationHandler) {
      this.characteristic.removeEventListener('characteristicvaluechanged', this.notificationHandler);
    }
    this.device?.gatt?.disconnect();
    this.characteristic = null;
    this.notificationHandler = null;
    this.onMeasurement = null;
    this.onState = null;
    this.profile = null;
    this.device = null;
    this.deviceName = null;
  }
}
