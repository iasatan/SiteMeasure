import type { BluetoothDeviceLike, BluetoothProvider } from '../types';

export class UnsupportedBluetoothProvider implements BluetoothProvider {
  readonly id = 'unsupported' as const;
  readonly label: string;

  constructor(readonly requiresExtension = false) {
    this.label = requiresExtension ? 'iOSWebBLE required' : 'Not available';
  }

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async requestDevice(): Promise<BluetoothDeviceLike> {
    if (this.requiresExtension) {
      throw new Error('Install and enable the iOSWebBLE Safari extension to connect a laser measure. Manual entry is still available.');
    }
    throw new Error('Bluetooth is unavailable in this browser. Manual entry is still available.');
  }
}
