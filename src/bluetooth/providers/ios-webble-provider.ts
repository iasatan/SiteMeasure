import type { BluetoothDeviceLike, BluetoothProvider, BluetoothRequestOptionsLike } from '../types';

type IOSWebBLE = {
  requestDevice(options: BluetoothRequestOptionsLike): Promise<BluetoothDeviceLike>;
};

type WebBLEWindow = Window & { webble?: IOSWebBLE };

export function isIOSBrowser(userAgent = navigator.userAgent, platform = navigator.platform): boolean {
  const iosDevice = /iPad|iPhone|iPod/.test(userAgent) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return iosDevice && /Safari/.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(userAgent);
}

export function hasIOSWebBLE(windowLike: Window = window): boolean {
  return Boolean((windowLike as WebBLEWindow).webble);
}

export class IOSWebBLEProvider implements BluetoothProvider {
  readonly id = 'ios-webble' as const;
  readonly label = 'iOSWebBLE';

  async isAvailable(): Promise<boolean> {
    return hasIOSWebBLE();
  }

  async requestDevice(options: BluetoothRequestOptionsLike): Promise<BluetoothDeviceLike> {
    const webble = (window as WebBLEWindow).webble;
    if (!webble) throw new Error('Enable the iOSWebBLE Safari extension, then try again.');
    return webble.requestDevice(options);
  }
}
