import { hasIOSWebBLE, IOSWebBLEProvider, isIOSBrowser } from './ios-webble-provider';
import { NativeWebBluetoothProvider } from './native-web-bluetooth-provider';
import { UnsupportedBluetoothProvider } from './unsupported-bluetooth-provider';
import type { BluetoothProvider } from '../types';

type ProviderEnvironment = {
  isIOS: boolean;
  hasIOSWebBLE: boolean;
  hasNativeBluetooth: boolean;
};

export function providerForEnvironment(environment: ProviderEnvironment): BluetoothProvider {
  if (environment.isIOS && environment.hasIOSWebBLE) return new IOSWebBLEProvider();
  if (environment.hasNativeBluetooth) return new NativeWebBluetoothProvider();
  return new UnsupportedBluetoothProvider(environment.isIOS && !environment.hasIOSWebBLE);
}

export function selectBluetoothProvider(): BluetoothProvider {
  const bluetooth = (navigator as Navigator & { bluetooth?: unknown }).bluetooth;
  return providerForEnvironment({
    isIOS: isIOSBrowser(),
    hasIOSWebBLE: hasIOSWebBLE(),
    hasNativeBluetooth: Boolean(bluetooth),
  });
}
