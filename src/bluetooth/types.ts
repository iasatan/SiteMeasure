export interface BluetoothRequestOptionsLike {
  acceptAllDevices?: boolean;
  filters?: Array<{ name?: string; namePrefix?: string; services?: BluetoothUuidLike[] }>;
  optionalServices?: BluetoothUuidLike[];
}

export type BluetoothUuidLike = string | number;

export interface BluetoothCharacteristicLike extends EventTarget {
  readonly value: DataView | null;
  readonly uuid: string;
  startNotifications(): Promise<BluetoothCharacteristicLike>;
  readValue?(): Promise<DataView>;
  writeValue?(value: BufferSource): Promise<void>;
}

export interface BluetoothServiceLike {
  getCharacteristic(uuid: BluetoothUuidLike): Promise<BluetoothCharacteristicLike>;
}

export interface BluetoothRemoteGattServerLike {
  readonly connected: boolean;
  connect(): Promise<BluetoothRemoteGattServerLike>;
  disconnect(): void;
  getPrimaryService(uuid: BluetoothUuidLike): Promise<BluetoothServiceLike>;
}

export interface BluetoothDeviceLike extends EventTarget {
  readonly id: string;
  readonly name?: string;
  readonly gatt?: BluetoothRemoteGattServerLike;
}

export interface BluetoothProvider {
  readonly id: 'ios-webble' | 'native' | 'unsupported';
  readonly label: string;
  isAvailable(): Promise<boolean>;
  requestDevice(options: BluetoothRequestOptionsLike): Promise<BluetoothDeviceLike>;
}

export type BluetoothConnectionState =
  | 'not-available'
  | 'extension-required'
  | 'ready'
  | 'searching'
  | 'connecting'
  | 'connected'
  | 'receiving'
  | 'disconnected'
  | 'error';

export interface ParsedMeasurement {
  valueMeters: number;
  capturedAt: string;
  deviceName: string;
  simulated?: boolean;
}

export interface MeasurementParserContext {
  deviceName: string;
  receivedAt: string;
}

export interface LaserMeasureAdapter {
  readonly providerId: BluetoothProvider['id'] | 'fake';
  readonly deviceName: string | null;
  connect(onMeasurement: (measurement: ParsedMeasurement) => void, onState: (state: BluetoothConnectionState, detail?: string) => void): Promise<void>;
  readCurrentMeasurement?(): Promise<void>;
  disconnect(): Promise<void>;
}
