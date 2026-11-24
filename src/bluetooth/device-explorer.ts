import type { BluetoothDeviceLike, BluetoothProvider } from './types';

interface ExplorerCharacteristic extends EventTarget {
  readonly uuid: string;
  readonly value?: DataView | null;
  readonly properties?: Partial<Record<'broadcast' | 'read' | 'writeWithoutResponse' | 'write' | 'notify' | 'indicate' | 'authenticatedSignedWrites' | 'reliableWrite' | 'writableAuxiliaries', boolean>>;
  readValue?(): Promise<DataView>;
  startNotifications?(): Promise<unknown>;
  getDescriptors?(): Promise<Array<{ uuid: string; readValue?(): Promise<DataView> }>>;
}

interface ExplorerService {
  readonly uuid: string;
  readonly isPrimary?: boolean;
  getCharacteristics(): Promise<ExplorerCharacteristic[]>;
  getIncludedServices?(): Promise<ExplorerService[]>;
}

interface ExplorerServer {
  connect(): Promise<ExplorerServer>;
  disconnect(): void;
  getPrimaryServices(): Promise<ExplorerService[]>;
}

type ExplorerDevice = Omit<BluetoothDeviceLike, 'gatt'> & {
  gatt?: ExplorerServer;
  watchAdvertisements?(): Promise<void>;
};

const BOSCH_SERVICES = [
  '00005301-0000-0041-4c50-574d494c4553',
  '02a6c0d0-0451-4000-b000-fb3210111989',
];

// Assigned 16-bit GATT service numbers. Web Bluetooth only exposes services that are declared up front.
const STANDARD_SERVICES = [
  0x1800, 0x1801, 0x1802, 0x1803, 0x1804, 0x1805, 0x1806, 0x1807, 0x1808, 0x1809, 0x180a, 0x180d, 0x180e, 0x180f,
  0x1810, 0x1811, 0x1812, 0x1813, 0x1814, 0x1815, 0x1816, 0x1818, 0x1819, 0x181a, 0x181b, 0x181c, 0x181d, 0x181e,
  0x181f, 0x1820, 0x1821, 0x1822, 0x1823, 0x1824, 0x1825, 0x1826, 0x1827, 0x1828, 0x1829, 0x182a, 0x183a, 0x183b,
  0x1843, 0x1844, 0x1845, 0x1846, 0x1847, 0x1848, 0x1849, 0x184a, 0x184b, 0x184c, 0x184d, 0x184e, 0x184f, 0x1850,
  0xfe59, 0xfe95, 0xfee0, 0xfee7, 0xfff0, 0xffe0, 0xffe5, 0xfe9f, 0xfd6f,
];

const STORAGE_KEY = 'sitemeasure.bluetooth.extraServices';

export function toFullUuid(uuid: number | string): string {
  if (typeof uuid === 'number') return `${uuid.toString(16).padStart(8, '0')}-0000-1000-8000-00805f9b34fb`;
  const trimmed = uuid.trim().toLowerCase();
  if (/^(0x)?[0-9a-f]{4}$/.test(trimmed)) return toFullUuid(parseInt(trimmed.replace('0x', ''), 16));
  return trimmed;
}

export function parseUuidList(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(toFullUuid)
    .filter((uuid) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid));
}

export function loadExtraServices(storage: Storage): string {
  return storage.getItem(STORAGE_KEY) ?? '';
}

export function saveExtraServices(storage: Storage, text: string): void {
  storage.setItem(STORAGE_KEY, text);
}

export function describeBytes(value: DataView): string {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const parts: string[] = [`${bytes.length}B`, `hex=${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ') || '(empty)'}`];
  parts.push(`ascii="${Array.from(bytes, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')}"`);
  if (bytes.length >= 1) parts.push(`u8=${value.getUint8(0)}`);
  if (bytes.length >= 2) parts.push(`u16le=${value.getUint16(0, true)}`);
  if (bytes.length >= 4) parts.push(`u32le=${value.getUint32(0, true)}`, `f32le=${Number(value.getFloat32(0, true).toPrecision(7))}`);
  if (bytes.length >= 8) parts.push(`f64le=${Number(value.getFloat64(0, true).toPrecision(10))}`);
  return parts.join(' | ');
}

export class DeviceExplorer {
  private device: ExplorerDevice | null = null;
  private readonly cleanups: Array<() => void> = [];

  constructor(
    private readonly provider: BluetoothProvider,
    private readonly log: (line: string) => void,
    private readonly onDisconnect: () => void,
  ) {}

  get connected(): boolean {
    return Boolean(this.device?.gatt && (this.device.gatt as unknown as { connected?: boolean }).connected);
  }

  async start(extraServicesText: string): Promise<void> {
    if (!(await this.provider.isAvailable())) throw new Error('Bluetooth provider is unavailable.');
    const extra = parseUuidList(extraServicesText);
    const optionalServices = Array.from(new Set([...BOSCH_SERVICES, ...STANDARD_SERVICES.map(toFullUuid), ...extra]));
    this.log(`Requesting any device; ${optionalServices.length} candidate services declared (${extra.length} custom).`);
    const device = (await this.provider.requestDevice({ acceptAllDevices: true, optionalServices })) as ExplorerDevice;
    this.device = device;
    this.log(`Selected device: name="${device.name ?? ''}" id=${device.id}`);
    this.listen(device, 'gattserverdisconnected', () => {
      this.log('EVENT gattserverdisconnected');
      this.onDisconnect();
    });
    for (const name of ['advertisementreceived', 'serviceadded', 'servicechanged', 'serviceremoved']) {
      this.listen(device, name, (event) => this.logAdvertisement(name, event));
    }
    if (device.watchAdvertisements) {
      try {
        await device.watchAdvertisements();
        this.log('Watching advertisements.');
      } catch (error) {
        this.log(`watchAdvertisements failed: ${messageOf(error)}`);
      }
    }
    if (!device.gatt) throw new Error('Device did not expose GATT.');
    const server = await device.gatt.connect();
    this.log('GATT connected.');
    await this.discover(server);
  }

  private async discover(server: ExplorerServer): Promise<void> {
    let services: ExplorerService[] = [];
    try {
      services = await server.getPrimaryServices();
    } catch (error) {
      this.log(`getPrimaryServices failed: ${messageOf(error)}`);
    }
    this.log(`Found ${services.length} service(s).`);
    for (const service of services) await this.exploreService(service, 'SERVICE');
  }

  private async exploreService(service: ExplorerService, label: string, depth = 0): Promise<void> {
    const pad = '  '.repeat(depth);
    this.log(`${pad}${label} ${service.uuid}`);
    let characteristics: ExplorerCharacteristic[] = [];
    try {
      characteristics = await service.getCharacteristics();
    } catch (error) {
      this.log(`${pad}  getCharacteristics failed: ${messageOf(error)}`);
    }
    for (const characteristic of characteristics) {
      const props = Object.entries(characteristic.properties ?? {}).filter(([, on]) => on).map(([name]) => name);
      this.log(`${pad}  CHAR ${characteristic.uuid} [${props.join(', ') || 'unknown properties'}]`);
      this.listen(characteristic, 'characteristicvaluechanged', (event) => {
        const target = (event.target as ExplorerCharacteristic | null) ?? characteristic;
        this.log(`EVENT characteristicvaluechanged ${characteristic.uuid}: ${target.value ? describeBytes(target.value) : '(no payload exposed)'}`);
      });
      if (characteristic.getDescriptors) {
        try {
          for (const descriptor of await characteristic.getDescriptors()) {
            let detail = '';
            try {
              detail = descriptor.readValue ? ` = ${describeBytes(await descriptor.readValue())}` : '';
            } catch (error) {
              detail = ` (read failed: ${messageOf(error)})`;
            }
            this.log(`${pad}    DESC ${descriptor.uuid}${detail}`);
          }
        } catch (error) {
          this.log(`${pad}    descriptors unavailable: ${messageOf(error)}`);
        }
      }
      if (characteristic.properties?.read && characteristic.readValue) {
        try {
          this.log(`${pad}    READ ${describeBytes(await characteristic.readValue())}`);
        } catch (error) {
          this.log(`${pad}    READ failed: ${messageOf(error)}`);
        }
      }
      if ((characteristic.properties?.notify || characteristic.properties?.indicate) && characteristic.startNotifications) {
        try {
          await characteristic.startNotifications();
          this.log(`${pad}    subscribed (${characteristic.properties.notify ? 'notify' : 'indicate'})`);
        } catch (error) {
          this.log(`${pad}    subscribe failed: ${messageOf(error)}`);
        }
      }
    }
    if (service.getIncludedServices) {
      try {
        for (const included of await service.getIncludedServices()) await this.exploreService(included, 'INCLUDED SERVICE', depth + 1);
      } catch {
        // Included services are optional and often unsupported.
      }
    }
  }

  private logAdvertisement(name: string, event: Event): void {
    const advert = event as Event & { rssi?: number; txPower?: number; appearance?: number; uuids?: string[]; manufacturerData?: Map<number, DataView>; serviceData?: Map<string, DataView> };
    const parts = [`EVENT ${name}`];
    if (advert.rssi !== undefined) parts.push(`rssi=${advert.rssi}`);
    if (advert.txPower !== undefined) parts.push(`txPower=${advert.txPower}`);
    if (advert.uuids?.length) parts.push(`uuids=${advert.uuids.join(',')}`);
    advert.manufacturerData?.forEach((data, id) => parts.push(`manufacturer 0x${id.toString(16)}: ${describeBytes(data)}`));
    advert.serviceData?.forEach((data, id) => parts.push(`serviceData ${id}: ${describeBytes(data)}`));
    this.log(parts.join(' '));
  }

  private listen(target: EventTarget, name: string, handler: (event: Event) => void): void {
    target.addEventListener(name, handler);
    this.cleanups.push(() => target.removeEventListener(name, handler));
  }

  disconnect(): void {
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
    try {
      this.device?.gatt?.disconnect();
    } catch {
      // Already disconnected.
    }
    this.device = null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
