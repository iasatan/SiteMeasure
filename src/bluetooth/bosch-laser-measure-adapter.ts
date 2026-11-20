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
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(profile.serviceUuid);
      const characteristic = await service.getCharacteristic(profile.measurementCharacteristicUuid);
      this.characteristic = await characteristic.startNotifications();
      this.notificationHandler = () => {
        const receivedAt = new Date().toISOString();
        if (!this.characteristic?.value) return;
        onState('receiving');
        const parsed = profile.parseMeasurement(this.characteristic.value, { deviceName: this.deviceName ?? profile.displayName, receivedAt });
        if (parsed) onMeasurement(parsed);
        onState('connected');
      };
      this.characteristic.addEventListener('characteristicvaluechanged', this.notificationHandler);
      device.addEventListener('gattserverdisconnected', () => {
        onState('disconnected');
        this.deviceName = null;
      }, { once: true });
      onState('connected');
    } catch (error) {
      onState('error', error instanceof Error ? error.message : 'The laser measure could not be connected.');
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.characteristic && this.notificationHandler) {
      this.characteristic.removeEventListener('characteristicvaluechanged', this.notificationHandler);
    }
    this.device?.gatt?.disconnect();
    this.characteristic = null;
    this.notificationHandler = null;
    this.device = null;
    this.deviceName = null;
  }
}
