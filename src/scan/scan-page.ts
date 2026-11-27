import { BoschLaserMeasureAdapter } from '../bluetooth/bosch-laser-measure-adapter';
import { loadCustomBoschProfile } from '../bluetooth/custom-bosch-profile';
import { selectBluetoothProvider } from '../bluetooth/providers/select-bluetooth-provider';
import type { BluetoothConnectionState, LaserMeasureAdapter, ParsedMeasurement } from '../bluetooth/types';
import { createId } from '../domain/models';
import type { ScanMode } from './scan-geometry';
import { createScanPreview, type ScanPreview } from './scan-preview';
import { loadScanRecords, orientationFromEvent, parseScanRecords, saveScanRecords, type ScanOrientation, type ScanRecord } from './scan-records';

type PermissionedOrientationEvent = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> };

/** Hidden page (#scan): each Bluetooth distance is stored with the phone's level and compass at that moment. */
export class ScanPage {
  private records: ScanRecord[];
  private orientation: ScanOrientation | null = null;
  private adapter: LaserMeasureAdapter | null = null;
  private state: BluetoothConnectionState = 'ready';
  private detail = '';
  private sensorsActive = false;
  private container: HTMLElement | null = null;
  private preview: ScanPreview | null = null;
  private mode: ScanMode = 'points';
  private readonly provider = selectBluetoothProvider();
  private readonly onOrientation = (event: Event): void => {
    const next = orientationFromEvent(event as DeviceOrientationEvent);
    if (!next) return;
    // Keep an absolute compass heading when a relative event arrives afterwards.
    this.orientation = { ...next, compassDegrees: next.compassDegrees ?? this.orientation?.compassDegrees ?? null };
    this.updateLive();
  };

  constructor(private readonly storage: Storage, private readonly toast: (message: string) => void, private readonly downloadText: (text: string, filename: string, mimeType: string) => void) {
    this.records = loadScanRecords(storage);
  }

  render(main: HTMLElement): void {
    this.preview?.dispose();
    this.preview = null;
    this.container = main;
    main.replaceChildren();
    const page = el('section', 'page scan-page');
    const heading = el('div', 'page-heading');
    const title = el('div');
    title.append(el('p', 'eyebrow', 'Hidden page'), el('h1', '', 'Scan'));
    heading.append(title);
    page.append(heading);

    const controls = el('div', 'project-tools');
    controls.append(
      button(this.sensorsActive ? 'Sensors on' : 'Enable sensors', 'button quiet compact', () => void this.enableSensors()),
      button('Connect laser', 'button primary compact', () => void this.connectLaser()),
      button('Disconnect', 'button quiet compact', () => void this.disconnectLaser()),
    );
    page.append(controls);

    const live = el('p', 'bluetooth-help');
    live.dataset.scanLive = '';
    page.append(live);

    const previewHeading = el('div', 'scan-preview-heading');
    previewHeading.append(el('h2', '', '3D scan'));
    const modeLabel = document.createElement('label');
    modeLabel.textContent = 'View ';
    const modeSelect = document.createElement('select');
    for (const [value, label] of [['points', 'Points'], ['path', 'Connected points'], ['surface', 'Surface'], ['smooth', 'Smoothed surface']] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      modeSelect.append(option);
    }
    modeSelect.value = this.mode;
    modeSelect.addEventListener('change', () => { this.mode = modeSelect.value as ScanMode; this.updatePreview(); });
    modeLabel.append(modeSelect);
    previewHeading.append(modeLabel);
    page.append(previewHeading);
    const previewHost = el('div', 'scan-preview');
    page.append(previewHost);
    const previewStatus = el('p', 'bluetooth-help');
    previewStatus.dataset.scanPreviewStatus = '';
    page.append(previewStatus);
    page.append(el('p', 'bluetooth-help', 'Estimate assumes all readings share one position and the phone tilt matches the laser elevation. Roll is not used.'));

    const list = el('div', 'scan-list');
    list.dataset.scanList = '';
    page.append(list);

    const actions = el('div', 'project-tools');
    const importInput = document.createElement('input');
    importInput.type = 'file';
    importInput.accept = '.json,application/json';
    importInput.hidden = true;
    importInput.addEventListener('change', () => {
      const file = importInput.files?.[0];
      importInput.value = '';
      if (file) void this.importFile(file);
    });
    actions.append(
      button('Import JSON', 'button quiet compact', () => importInput.click()),
      button('Download JSON', 'button quiet compact', () => this.download()),
      button('Clear list', 'button quiet compact', () => this.clear()),
      importInput,
    );
    page.append(actions);
    main.append(page);
    this.preview = createScanPreview(previewHost);
    if (!this.preview) previewHost.textContent = '3D preview is unavailable in this browser.';
    this.updateLive();
    this.renderList();
  }

  dispose(): void {
    window.removeEventListener('deviceorientationabsolute', this.onOrientation, true);
    window.removeEventListener('deviceorientation', this.onOrientation, true);
    this.sensorsActive = false;
    void this.disconnectLaser();
    this.preview?.dispose();
    this.preview = null;
    this.container = null;
  }

  /** Stores a distance together with the latest phone orientation. */
  addMeasurement(reading: Pick<ParsedMeasurement, 'valueMeters' | 'capturedAt'>): ScanRecord | null {
    if (!this.orientation) {
      this.toast('Enable sensors first, so the orientation can be stored with the distance');
      return null;
    }
    const record: ScanRecord = { id: createId(), capturedAt: reading.capturedAt, orientation: { ...this.orientation }, distanceMeters: reading.valueMeters };
    this.records.push(record);
    saveScanRecords(this.storage, this.records);
    this.renderList();
    return record;
  }

  private async enableSensors(): Promise<void> {
    if (typeof window.DeviceOrientationEvent === 'undefined') {
      this.toast('This browser does not expose orientation sensors');
      return;
    }
    const permission = (window.DeviceOrientationEvent as PermissionedOrientationEvent).requestPermission;
    if (typeof permission === 'function') {
      try {
        if ((await permission.call(window.DeviceOrientationEvent)) !== 'granted') {
          this.toast('Motion and orientation permission was denied');
          return;
        }
      } catch {
        this.toast('Motion and orientation permission could not be requested');
        return;
      }
    }
    window.addEventListener('deviceorientationabsolute', this.onOrientation, true);
    window.addEventListener('deviceorientation', this.onOrientation, true);
    this.sensorsActive = true;
    if (this.container) this.render(this.container);
  }

  private async connectLaser(): Promise<void> {
    await this.disconnectLaser();
    const customProfile = loadCustomBoschProfile(this.storage);
    const adapter = new BoschLaserMeasureAdapter(this.provider, customProfile ? [customProfile] : undefined);
    this.adapter = adapter;
    try {
      await adapter.connect(
        (reading) => { this.addMeasurement(reading); },
        (state, detail) => { this.state = state; this.detail = detail ?? ''; this.updateLive(); },
      );
    } catch {
      this.updateLive();
    }
  }

  private async disconnectLaser(): Promise<void> {
    const adapter = this.adapter;
    this.adapter = null;
    await adapter?.disconnect();
    if (adapter) { this.state = 'ready'; this.detail = ''; this.updateLive(); }
  }

  private updateLive(): void {
    const live = this.container?.querySelector<HTMLElement>('[data-scan-live]');
    if (!live) return;
    const o = this.orientation;
    const orientation = o
      ? `Level ${o.levelBeta.toFixed(1)}° / ${o.levelGamma.toFixed(1)}°, compass ${o.compassDegrees === null ? 'n/a' : `${o.compassDegrees.toFixed(0)}°`}`
      : 'Orientation: waiting for sensors';
    live.textContent = `${orientation} · Bluetooth: ${this.state}${this.detail ? ` (${this.detail})` : ''}`;
  }

  private renderList(): void {
    this.updatePreview(true);
    const list = this.container?.querySelector<HTMLElement>('[data-scan-list]');
    if (!list) return;
    list.replaceChildren();
    if (!this.records.length) list.append(el('p', 'measurements-empty', 'No scans stored yet.'));
    this.records.forEach((record, index) => {
      const { levelBeta, levelGamma, compassDegrees } = record.orientation;
      const compass = compassDegrees === null ? 'n/a' : `${compassDegrees.toFixed(0)}°`;
      list.append(el('p', '', `${index + 1}. ${record.distanceMeters.toFixed(3)} m · level ${levelBeta.toFixed(1)}° / ${levelGamma.toFixed(1)}° · compass ${compass}`));
    });
  }

  private updatePreview(fit = false): void {
    const status = this.container?.querySelector<HTMLElement>('[data-scan-preview-status]');
    if (!this.preview || !status) return;
    const { count, triangles } = this.preview.setScan(this.records, this.mode, fit);
    const skipped = this.records.length - count;
    const details = [`${count} usable ${count === 1 ? 'point' : 'points'}`];
    if (skipped) details.push(`${skipped} skipped (missing or invalid direction or distance)`);
    if ((this.mode === 'surface' || this.mode === 'smooth') && count && !triangles) details.push('Surface requires at least three distinct, non-collinear directions');
    status.textContent = details.join(' · ');
  }

  private clear(): void {
    this.records = [];
    saveScanRecords(this.storage, this.records);
    this.renderList();
  }

  private download(): void {
    this.downloadText(JSON.stringify(this.records, null, 2), 'sitemeasure-scan.json', 'application/json');
  }

  private async importFile(file: File): Promise<void> {
    try {
      const imported = parseScanRecords(await file.text());
      const ids = new Set(this.records.map((record) => record.id));
      const added = imported.filter((record) => {
        if (ids.has(record.id)) return false;
        ids.add(record.id);
        return true;
      });
      const records = [...this.records, ...added];
      saveScanRecords(this.storage, records);
      this.records = records;
      this.renderList();
      const skipped = imported.length - added.length;
      this.toast(`Imported ${added.length} scan ${added.length === 1 ? 'reading' : 'readings'}${skipped ? `; ${skipped} already present` : ''}.`);
    } catch (error) {
      this.toast(error instanceof Error ? error.message : 'The scan file could not be imported.');
    }
  }
}

function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}
