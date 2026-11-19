import type { BluetoothDeviceLike, BluetoothProvider, BluetoothRequestOptionsLike } from '../types';

type BluetoothNavigator = Navigator & {
  bluetooth?: {
    requestDevice(options: BluetoothRequestOptionsLike): Promise<BluetoothDeviceLike>;
  };
};

export class NativeWebBluetoothProvider implements BluetoothProvider {
  readonly id = 'native' as const;
  readonly label = 'Web Bluetooth';

  async isAvailable(): Promise<boolean> {
    return Boolean((navigator as BluetoothNavigator).bluetooth);
  }

  async requestDevice(options: BluetoothRequestOptionsLike): Promise<BluetoothDeviceLike> {
    const bluetooth = (navigator as BluetoothNavigator).bluetooth;
    if (!bluetooth) throw new Error('Web Bluetooth is unavailable in this browser.');
    return bluetooth.requestDevice(options);
  }
}
