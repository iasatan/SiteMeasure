import { describe, expect, it } from 'vitest';
import { providerForEnvironment } from '../src/bluetooth/providers/select-bluetooth-provider';
import { validateBoschProfile, type BoschDeviceProfile } from '../src/bluetooth/profiles/bosch-device-profile';
import { createCustomBoschProfile, loadCustomBoschProfileSettings, saveCustomBoschProfile } from '../src/bluetooth/custom-bosch-profile';
import { MeasurementCapture } from '../src/bluetooth/measurement-capture';
import { createProject, createRoom } from '../src/domain/models';
import { SiteMeasureApp } from '../src/app';
import { LocalStorageProjectRepository } from '../src/data/local-storage-repository';
import type { ParsedMeasurement } from '../src/bluetooth/types';

const validProfile: BoschDeviceProfile = {
  profileId: 'test-profile',
  displayName: 'Test meter',
  namePrefixes: ['TEST'],
  serviceUuid: '0000ffe0-0000-1000-8000-00805f9b34fb',
  measurementCharacteristicUuid: '0000ffe1-0000-1000-8000-00805f9b34fb',
  parseMeasurement: () => null,
};

describe('Bluetooth provider selection', () => {
  it('prefers iOSWebBLE on iOS when the extension is present', () => {
    expect(providerForEnvironment({ isIOS: true, hasIOSWebBLE: true, hasNativeBluetooth: true }).id).toBe('ios-webble');
  });

  it('falls back to native Bluetooth outside iOS', () => {
    expect(providerForEnvironment({ isIOS: false, hasIOSWebBLE: false, hasNativeBluetooth: true }).id).toBe('native');
  });

  it('requires an extension on iOS without iOSWebBLE', () => {
    const provider = providerForEnvironment({ isIOS: true, hasIOSWebBLE: false, hasNativeBluetooth: false });
    expect(provider.id).toBe('unsupported');
    expect(provider.label).toBe('iOSWebBLE required');
  });
});

describe('Bosch profile validation', () => {
  it('accepts structurally complete profiles', () => {
    expect(() => validateBoschProfile(validProfile)).not.toThrow();
  });

  it('rejects unverified TODO protocol values', () => {
    expect(() => validateBoschProfile({ ...validProfile, serviceUuid: 'TODO_VERIFIED_SERVICE_UUID' })).toThrow(/verified BLE UUID/);
  });
});

describe('custom Bosch profiles', () => {
  it('persists a configurable profile and decodes its measurement payload', () => {
    const settings = {
      displayName: 'My Bosch GLM',
      namePrefix: 'Bosch GLM',
      serviceUuid: '0000ffe0-0000-1000-8000-00805f9b34fb',
      measurementCharacteristicUuid: '0000ffe1-0000-1000-8000-00805f9b34fb',
      payloadFormat: 'float32-le-m' as const,
      byteOffset: 1,
    };
    saveCustomBoschProfile(localStorage, settings);
    expect(loadCustomBoschProfileSettings(localStorage)).toEqual(settings);
    const profile = createCustomBoschProfile(settings);
    const bytes = new Uint8Array([99, 0, 0, 0, 0]);
    new DataView(bytes.buffer).setFloat32(1, 2.45, true);
    expect(profile.parseMeasurement(new DataView(bytes.buffer), { deviceName: 'Bosch GLM', receivedAt: '2026-01-01T00:00:00.000Z' })?.valueMeters).toBeCloseTo(2.45);
  });

  it('decodes a Bosch GLM logging packet current value', () => {
    const profile = createCustomBoschProfile({
      displayName: 'Bosch GLM',
      namePrefix: 'GLM100-',
      serviceUuid: 'fde8',
      measurementCharacteristicUuid: '02a6c0d2-0451-4000-b000-fb3210111989',
      payloadFormat: 'bosch-glm20',
      byteOffset: 0,
    });
    const packet = new Uint8Array([0xc0, 0x55, 0x10, 0x0a, 0x08, 0x6a, 0x00, 0xdc, 0xd7, 0xc1, 0x3f, 0x4e, 0xd1, 0xc1, 0x3f, 0xc6, 0xdc, 0xc1, 0x3f, 0x3c]);
    expect(profile.parseMeasurement(new DataView(packet.buffer), { deviceName: 'GLM100-test', receivedAt: '2026-01-01T00:00:00.000Z' })?.valueMeters).toBeCloseTo(1.5144, 5);
    expect(profile.setupCommand).toEqual(new Uint8Array([0xc0, 0x55, 0x02, 0x01, 0x00, 0x1a]));
  });

  it('rejects incomplete device identifiers and UUIDs', () => {
    expect(() => createCustomBoschProfile({ displayName: '', namePrefix: '', serviceUuid: 'TODO', measurementCharacteristicUuid: '' })).toThrow();
  });
});

describe('measurement capture', () => {
  it('applies a confirmed BLE reading to the chosen photo dimension and persists it', () => {
    localStorage.clear();
    const repository = new LocalStorageProjectRepository(localStorage);
    const project = createProject('Measured photo');
    const room = project.buildings[0].floors[0].rooms[0];
    const photo = {
      id: 'photo', title: 'Wall', notes: '', dataUrl: 'data:image/jpeg;base64,AAAA', mimeType: 'image/jpeg' as const,
      width: 1200, height: 800, sizeBytes: 4, capturedAt: '2026-01-01T00:00:00.000Z',
      annotations: [{ id: 'shape', type: 'rectangle' as const, x: 0.1, y: 0.2, endX: 0.8, endY: 0.7, color: '#e85d3f' }],
    };
    room.photos.push(photo);
    repository.save(project);
    const root = document.createElement('div');
    document.body.append(root);
    const app = new SiteMeasureApp(root) as unknown as {
      showPhotoDialog(projectArg: typeof project, roomArg: typeof room, photoArg: typeof photo): void;
      receiveBluetoothMeasurement(reading: ParsedMeasurement): void;
      bluetoothCapture: MeasurementCapture;
    };
    const dialog = root.querySelector<HTMLDialogElement>('dialog')!;
    dialog.showModal = () => dialog.setAttribute('open', '');
    dialog.close = () => dialog.removeAttribute('open');
    app.showPhotoDialog(project, room, photo);
    const dimension = dialog.querySelector<HTMLSelectElement>('[aria-label="Annotation dimension"]')!;
    dimension.value = 'heightMeters';
    dimension.dispatchEvent(new Event('change'));
    app.receiveBluetoothMeasurement({ valueMeters: 2.45, capturedAt: '2026-01-01T00:00:00.000Z', deviceName: 'Meter A' });
    expect(app.bluetoothCapture.list()).toHaveLength(1);
    expect(photo.annotations[0]).not.toHaveProperty('heightMeters');
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Apply')!.click();
    expect(photo.annotations[0]).toHaveProperty('heightMeters', 2.45);
    expect(photo.annotations[0]).not.toHaveProperty('widthMeters');
    expect(app.bluetoothCapture.list()).toHaveLength(0);
    expect(dialog.querySelector('.photo-annotations')?.textContent).toContain('2.45 m');
    dimension.value = 'widthMeters';
    dimension.dispatchEvent(new Event('change'));
    app.receiveBluetoothMeasurement({ valueMeters: 0, capturedAt: '2026-01-01T00:00:00.000Z', deviceName: 'Meter A' });
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Apply')!.click();
    expect(photo.annotations[0]).not.toHaveProperty('widthMeters');
    expect(app.bluetoothCapture.list()).toHaveLength(1);
    app.receiveBluetoothMeasurement({ valueMeters: 1.2, capturedAt: '2026-01-01T00:00:00.000Z', deviceName: 'Meter A' });
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Apply')!.click();
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Save')!.click();
    const savedRoom = repository.get(project.id)?.buildings[0].floors[0].rooms[0];
    expect(savedRoom?.photos[0].annotations[0]).toMatchObject({ heightMeters: 2.45, widthMeters: 1.2 });
    expect(savedRoom?.measurements).toHaveLength(0);
    root.remove();
  });

  it('applies manual and laser clearance measurements without resizing the object', () => {
    const repository = new LocalStorageProjectRepository(localStorage);
    const project = createProject('Clearance measurement');
    const room = project.buildings[0].floors[0].rooms[0];
    room.points = [[0, 0], [4, 0], [4, 4], [0, 4]].map(([xMeters, yMeters]) => ({ xMeters, yMeters }));
    room.walls = room.points.map((start, index) => ({ id: `wall${index}`, start, end: room.points[(index + 1) % 4], thicknessMeters: 0.15 }));
    room.objects = [{ id: 'object', name: 'Cabinet', widthMeters: 1, depthMeters: 0.5, heightMeters: 1, xMeters: 1, yMeters: 0.5 }];
    repository.save(project);
    const root = document.createElement('div');
    document.body.append(root);
    const app = new SiteMeasureApp(root) as unknown as {
      openProject(id: string): void;
      receiveBluetoothMeasurement(reading: ParsedMeasurement): void;
      activeEditor: { handleSelectionPointer(point: { xMeters: number; yMeters: number }, target: SVGElement | null): void };
      bluetoothCapture: MeasurementCapture;
    };
    app.openProject(project.id);
    const dialog = root.querySelector<HTMLDialogElement>('dialog')!;
    dialog.showModal = () => dialog.setAttribute('open', '');
    dialog.close = () => dialog.removeAttribute('open');
    const layer = root.querySelector<HTMLSelectElement>('[aria-label="Editing layer"]')!;
    layer.value = 'designer';
    layer.dispatchEvent(new Event('change'));
    const view = root.querySelector<HTMLSelectElement>('[aria-label="Editor view"]')!;
    view.value = 'wall0';
    view.dispatchEvent(new Event('change'));
    app.activeEditor.handleSelectionPointer({ xMeters: 1.5, yMeters: -0.5 }, root.querySelector<SVGElement>('.editor-elevation-object'));
    expect(root.querySelectorAll('.editor-clearance')).toHaveLength(4);
    root.querySelector<SVGElement>('[data-clearance="ceiling"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    dialog.querySelector('input')!.value = '0.4';
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Apply')!.click();
    expect(dialog.open).toBe(false);
    expect(root.querySelectorAll('.editor-clearance')).toHaveLength(2);
    [...root.querySelectorAll('button')].find((item) => item.textContent?.startsWith('Left wall:'))!.click();
    app.receiveBluetoothMeasurement({ valueMeters: 5, capturedAt: '2026-01-01T00:00:00.000Z', deviceName: 'Meter A' });
    expect(dialog.open).toBe(true);
    expect(app.bluetoothCapture.list()).toHaveLength(1);
    app.receiveBluetoothMeasurement({ valueMeters: 0.6, capturedAt: '2026-01-01T00:00:01.000Z', deviceName: 'Meter A' });
    const saved = repository.get(project.id)!.buildings[0].floors[0].rooms[0];
    expect(saved.objects[0].widthMeters).toBe(1);
    expect(saved.objects[0].xMeters).toBeCloseTo(0.6);
    expect(saved.objects[0].elevationMeters).toBeCloseTo(1.3);
    expect(saved.measurements.map((entry) => entry.clearance)).toEqual([{ side: 'ceiling', wallId: 'wall0' }, { side: 'left', wallId: 'wall0' }]);
    expect(saved.measurements[1].source).toBe('bluetooth');
    expect(root.querySelectorAll('.editor-clearance')).toHaveLength(0);
    expect(app.bluetoothCapture.list()).toHaveLength(0);
    root.remove();
  });

  it('applies incoming readings to the selected plan item and persists them', () => {
    const repository = new LocalStorageProjectRepository(localStorage);
    const project = createProject('Device measurement');
    const room = project.buildings[0].floors[0].rooms[0];
    room.walls = [{ id: 'wall', start: { xMeters: 0, yMeters: 0 }, end: { xMeters: 4, yMeters: 0 }, thicknessMeters: 0.15 }];
    room.windows = [{ id: 'window', wallId: 'wall', offsetMeters: 1, widthMeters: 0.8 }];
    room.objects = [{ id: 'object', name: 'Cabinet', widthMeters: 1, depthMeters: 0.5, heightMeters: 1, xMeters: 1, yMeters: 1 }];
    repository.save(project);
    const root = document.createElement('div');
    document.body.append(root);
    const app = new SiteMeasureApp(root) as unknown as {
      openProject(id: string): void;
      receiveBluetoothMeasurement(reading: ParsedMeasurement): void;
      bluetoothCapture: MeasurementCapture;
      activeEditor: { handleSelectionPointer(point: { xMeters: number; yMeters: number }, target: SVGElement | null): void };
    };
    app.openProject(project.id);
    const editor = app.activeEditor;
    const reading = (valueMeters: number) => ({ valueMeters, capturedAt: '2026-01-01T00:00:00.000Z', deviceName: 'Meter A' });
    editor.handleSelectionPointer({ xMeters: 2, yMeters: 0 }, root.querySelector<SVGElement>('.editor-wall[data-wall-id="wall"]'));
    app.receiveBluetoothMeasurement(reading(3));
    let saved = repository.get(project.id)!.buildings[0].floors[0].rooms[0];
    expect(saved.walls[0].end.xMeters).toBe(3);
    expect(saved.measurements[0]).toMatchObject({ targetType: 'wall', targetId: 'wall', valueMeters: 3, source: 'bluetooth' });
    expect(app.bluetoothCapture.list()).toHaveLength(0);

    editor.handleSelectionPointer({ xMeters: 1.4, yMeters: 0 }, root.querySelector<SVGElement>('[data-opening-id="window"]'));
    app.receiveBluetoothMeasurement(reading(5));
    expect(app.bluetoothCapture.list()).toHaveLength(1);
    app.receiveBluetoothMeasurement(reading(1));
    saved = repository.get(project.id)!.buildings[0].floors[0].rooms[0];
    expect(saved.windows[0].widthMeters).toBe(1);
    expect(saved.measurements[1]).toMatchObject({ targetType: 'other', targetId: 'window', valueMeters: 1 });
    expect(app.bluetoothCapture.list()).toHaveLength(0);

    const dialog = root.querySelector<HTMLDialogElement>('.app-dialog')!;
    dialog.setAttribute('open', '');
    const manualInput = document.createElement('input');
    manualInput.value = 'draft';
    dialog.append(manualInput);
    app.receiveBluetoothMeasurement(reading(0.7));
    expect(repository.get(project.id)!.buildings[0].floors[0].rooms[0].windows[0].widthMeters).toBe(0.7);
    expect(manualInput.value).toBe('draft');
    expect(app.bluetoothCapture.list()).toHaveLength(0);

    dialog.removeAttribute('open');
    dialog.showModal = () => dialog.setAttribute('open', '');
    dialog.close = () => dialog.removeAttribute('open');
    const layer = root.querySelector<HTMLSelectElement>('[aria-label="Editing layer"]')!;
    layer.value = 'designer';
    layer.dispatchEvent(new Event('change'));
    const objectEditor = app.activeEditor;
    objectEditor.handleSelectionPointer({ xMeters: 1.1, yMeters: 1.1 }, root.querySelector<SVGElement>('.editor-object[data-object-id="object"]'));
    app.receiveBluetoothMeasurement(reading(1.5));
    saved = repository.get(project.id)!.buildings[0].floors[0].rooms[0];
    expect(saved.objects[0].widthMeters).toBe(1.5);
    expect(saved.measurements.at(-1)).toMatchObject({ targetId: 'object', valueMeters: 1.5, source: 'bluetooth' });
    root.querySelector<SVGElement>('.editor-object[data-object-id="object"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(dialog.open).toBe(true);
    const inputs = dialog.querySelectorAll<HTMLInputElement>('input');
    inputs[1].value = '2';
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Apply')!.click();
    saved = repository.get(project.id)!.buildings[0].floors[0].rooms[0];
    expect(saved.objects[0].widthMeters).toBe(2);
    expect(saved.measurements.at(-1)).toMatchObject({ targetId: 'object', valueMeters: 2, source: 'manual' });
    root.remove();
  });

  it('replaces the pending value with each new reading', () => {
    const capture = new MeasurementCapture();
    const first = capture.receive({ valueMeters: 1.2, capturedAt: '2026-01-01T00:00:00.000Z', deviceName: 'Meter A' });
    const second = capture.receive({ valueMeters: 2.3, capturedAt: '2026-01-01T00:00:01.000Z', deviceName: 'Meter A' });
    expect(capture.list()).toEqual([{ ...second, sequence: 2 }]);
    expect(first.sequence).toBe(1);
  });

  it('applies the newest pending value', () => {
    const capture = new MeasurementCapture();
    const room = createRoom();
    capture.receive({ valueMeters: 2.5, capturedAt: '2026-01-01T00:00:00.000Z', deviceName: 'Meter A' });
    const latest = capture.receive({ valueMeters: 3.5, capturedAt: '2026-01-01T00:00:01.000Z', deviceName: 'Meter A' });

    const measurement = capture.confirm(latest.id, room, 'other', room.id);
    expect(measurement?.valueMeters).toBe(3.5);
    expect(capture.list()).toHaveLength(0);
    expect(room.measurements).toHaveLength(1);
  });
});
