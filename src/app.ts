import { copyImportedProject, projectFilename, readBackupFile, readProjectFile, serializeBackup, serializeProject, type BackupFile } from './data/project-files';
import { ObjectLibrary } from './data/object-library';
import { cloneParts, partBounds, type ObjectDefinition } from './domain/furniture';
import { ObjectsPage } from './objects/objects-page';
import { ScanPage } from './scan/scan-page';
import { SpeedometerPage } from './speedometer/speedometer-page';
import { TargetPracticePage } from './target-practice/target-practice-page';
import { LocalStorageProjectRepository, type RepositoryWarning } from './data/local-storage-repository';
import { createId, createProject, createRoom, DEFAULT_DOOR_HEIGHT_METERS, DEFAULT_WINDOW_HEIGHT_METERS, type EditingLayer, type PhotoAnnotation, type Project, type ProjectPhoto, type ProjectSummary, type Room } from './domain/models';
import { FloorPlanEditor, type ClearanceSide, type EditorSelection } from './editor/floor-plan-editor';
import { deriveOpeningSegments, distanceBetween, formatArea, formatLength, formatVolume, openingArea, polygonIssues, roomArea, roomHeight, roomVolume, wallArea, type OpeningSegmentKey } from './geometry';
import { BoschLaserMeasureAdapter } from './bluetooth/bosch-laser-measure-adapter';
import { clearCustomBoschProfile, loadCustomBoschProfile, loadCustomBoschProfileSettings, saveCustomBoschProfile, type BoschPayloadFormat } from './bluetooth/custom-bosch-profile';
import { DeviceExplorer, loadExtraServices, saveExtraServices } from './bluetooth/device-explorer';
import { MeasurementCapture } from './bluetooth/measurement-capture';
import { selectBluetoothProvider } from './bluetooth/providers/select-bluetooth-provider';
import type { BluetoothConnectionState, LaserMeasureAdapter, ParsedMeasurement } from './bluetooth/types';
import { normalizedPoint, renderPhotoAnnotations } from './photos/photo-annotations';
import { processPhoto } from './photos/photo-processing';
import { floorPlanSvg, measurementsCsv, printableReport, svgToPng } from './reports/project-exports';
import type { DebugLog } from './debug-log';

type PrimaryView = 'projects' | 'plan' | 'objects' | 'measure' | 'photos' | 'more' | 'misc' | 'ble' | 'scan' | 'speedometer' | 'target-practice';
const primaryViews: readonly string[] = ['projects', 'plan', 'objects', 'measure', 'photos', 'more', 'misc', 'ble', 'scan', 'speedometer', 'target-practice'];
const isPrimaryView = (value: string): value is PrimaryView => primaryViews.includes(value);

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface UndoDeletion {
  project: Project;
  expiresAt: number;
}

const navItems: Array<{ id: PrimaryView; label: string }> = [
  { id: 'projects', label: 'Projects' },
  { id: 'objects', label: 'Objects' },
  { id: 'measure', label: 'Measure' },
  { id: 'photos', label: 'Photos' },
  { id: 'more', label: 'More' },
  { id: 'misc', label: 'Misc' },
];

export class SiteMeasureApp {
  private readonly root: HTMLElement;
  private readonly repository: LocalStorageProjectRepository;
  private readonly bluetoothProvider = selectBluetoothProvider();
  private readonly bluetoothCapture = new MeasurementCapture();
  private bluetoothAdapter: LaserMeasureAdapter | null = null;
  private bluetoothState: BluetoothConnectionState = 'ready';
  private bluetoothDetail = '';
  private deviceExplorer: DeviceExplorer | null = null;
  private explorerLog: string[] = [];
  private measurementPanelContext: { project: Project; room: Room; wall?: Project['buildings'][number]['floors'][number]['rooms'][number]['walls'][number]; clearanceSide?: ClearanceSide } | null = null;
  private clearanceMeasurement: { objectId: string; side: ClearanceSide; content: HTMLElement } | null = null;
  private photoMeasurement: { content: HTMLElement; refresh: () => void } | null = null;
  private readonly objectsPage = new ObjectsPage(new ObjectLibrary(localStorage), {
    layer: () => this.layer === 'technician' ? 'technician' : 'designer',
    projects: () => this.repository.list().map((summary) => ({ id: summary.id, name: summary.name })),
    rooms: (projectId) => {
      const project = this.repository.get(projectId);
      return project ? project.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.rooms.map((room) => ({ id: room.id, name: `${building.name} / ${floor.name} / ${room.name}` })))) : [];
    },
    insert: (definition, projectId, roomId) => this.insertObject(definition, projectId, roomId),
    openPlan: (projectId, roomId) => { this.activeRoomId = roomId; this.openProject(projectId); },
    download: (text, filename, mimeType) => this.downloadText(text, filename, mimeType),
    toast: (message) => this.showToast(message),
    confirm: (message, onConfirm) => this.showConfirmationDialog('Replace saved object?', message, onConfirm),
  });
  private readonly scanPage = new ScanPage(localStorage, (message) => this.showToast(message), (text, filename, mimeType) => this.downloadText(text, filename, mimeType), () => this.setView('misc'));
  private readonly speedometerPage = new SpeedometerPage(localStorage, (message) => this.showToast(message), () => this.setView('misc'));
  private readonly targetPracticePage = new TargetPracticePage(localStorage, (message) => this.showToast(message), () => this.setView('misc'));
  private view: PrimaryView = 'projects';
  private layer: EditingLayer = 'builder';
  private selectedProjectId: string | null = null;
  private dirty = false;
  private saveState: SaveState = 'idle';
  private saveTime: string | null = null;
  private saveTimer: number | undefined;
  private toastHideTimer: number | undefined;
  private undoTimer: number | undefined;
  private undoDeletion: UndoDeletion | null = null;
  private searchTerm = '';
  private showArchived = false;
  private notice = '';
  private activeRoomId: string | null = null;
  private activeEditor: FloorPlanEditor | null = null;
  private editorSelection: EditorSelection = null;

  constructor(root: HTMLElement, repositoryWarning?: RepositoryWarning, private readonly debugLog?: DebugLog) {
    this.root = root;
    this.repository = new LocalStorageProjectRepository(localStorage, (message) => {
      this.notice = message;
      repositoryWarning?.(message);
      this.renderNotice();
    });
    if (this.bluetoothProvider.id === 'unsupported') {
      this.bluetoothState = this.bluetoothProvider.label === 'iOSWebBLE required' ? 'extension-required' : 'not-available';
    }

    window.addEventListener('beforeunload', (event) => {
      if (this.dirty) {
        event.preventDefault();
      }
    });
    this.renderShell();
    this.syncHiddenRoute();
    window.addEventListener('hashchange', () => { this.syncHiddenRoute(); this.render(); });
    this.render();
  }

  private syncHiddenRoute(): void {
    const route = window.location.hash.replace(/^#\/?/, '');
    if (isPrimaryView(route)) {
      this.disposeFeature(route);
      this.view = route;
    } else if (this.view === 'scan' || this.view === 'speedometer' || this.view === 'target-practice') {
      this.disposeFeature('projects');
      this.view = 'projects';
    }
  }

  private renderShell(): void {
    this.root.innerHTML = `
      <div class="app-frame">
        <header class="app-header">
          <button class="brand-button" type="button" data-view="projects" aria-label="SiteMeasure projects">
            <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
            <span>SiteMeasure</span>
          </button>
          <span class="app-version">v${__APP_VERSION__}</span>
          <label class="layer-picker"><span class="visually-hidden">Editing layer</span><select aria-label="Editing layer"><option value="builder">Builder</option><option value="technician">Technician</option><option value="designer">Designer</option></select></label>
          <div class="save-indicator" role="status" aria-live="polite"></div>
        </header>
        <div class="notice" role="status" aria-live="polite" hidden></div>
        <nav class="bottom-nav" aria-label="Primary navigation"></nav>
        <main class="app-main"></main>
      </div>
      <dialog class="app-dialog" aria-labelledby="dialog-title"></dialog>
      <input class="visually-hidden" type="file" accept=".sitemeasure.json,application/json" data-import-input />
      <input class="visually-hidden" type="file" accept=".sitemeasure-backup.json,application/json" data-backup-input />
      <input class="visually-hidden" type="file" accept="image/*" data-photo-library />
      <input class="visually-hidden" type="file" accept="image/*" capture="environment" data-photo-camera />
      <div class="toast" role="status" aria-live="polite" hidden></div>
    `;

    this.root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
      button.addEventListener('click', () => this.setView(button.dataset.view as PrimaryView));
    });
    this.root.querySelector<HTMLSelectElement>('.layer-picker select')?.addEventListener('change', (event) => {
      this.layer = (event.currentTarget as HTMLSelectElement).value as EditingLayer;
      if (this.layer === 'builder' && this.view === 'objects') this.view = this.selectedProjectId ? 'plan' : 'projects';
      this.editorSelection = null;
      this.render();
    });
    this.root.querySelector<HTMLInputElement>('[data-import-input]')?.addEventListener('change', (event) => {
      void this.handleImport((event.currentTarget as HTMLInputElement).files?.[0]);
    });
    this.root.querySelector<HTMLInputElement>('[data-backup-input]')?.addEventListener('change', (event) => {
      void this.handleBackupImport((event.currentTarget as HTMLInputElement).files?.[0]);
    });
    for (const input of this.root.querySelectorAll<HTMLInputElement>('[data-photo-library], [data-photo-camera]')) {
      input.addEventListener('change', () => {
        void this.handlePhoto(input.files?.[0], input);
      });
    }
    this.renderNavigation();
  }

  private renderNavigation(): void {
    const navigation = this.root.querySelector<HTMLElement>('.bottom-nav');
    if (!navigation) return;
    navigation.replaceChildren();
    for (const item of navItems) {
      if (item.id === 'objects' && this.layer === 'builder') continue;
      const button = document.createElement('button');
      button.type = 'button';
      const active = item.id === this.view || (item.id === 'misc' && (this.view === 'scan' || this.view === 'speedometer' || this.view === 'target-practice'));
      button.className = active ? 'nav-item is-active' : 'nav-item';
      button.setAttribute('aria-current', item.id === this.view ? 'page' : active ? 'location' : 'false');
      const glyph = document.createElement('span');
      glyph.className = 'nav-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = navSymbol(item.id);
      const label = document.createElement('span');
      label.textContent = item.label;
      button.append(glyph, label);
      button.addEventListener('click', () => this.setView(item.id));
      navigation.append(button);
    }
  }

  private render(): void {
    this.renderNavigation();
    const main = this.root.querySelector<HTMLElement>('.app-main');
    if (!main) return;
    main.replaceChildren();

    switch (this.view) {
      case 'projects':
        this.renderProjects(main);
        break;
      case 'plan':
        this.renderWorkspace(main);
        break;
      case 'objects':
        this.objectsPage.render(main);
        break;
      case 'measure':
        this.renderMeasurements(main);
        break;
      case 'photos':
        this.renderPhotos(main);
        break;
      case 'more':
        this.renderMore(main);
        break;
      case 'misc':
        this.renderMisc(main);
        break;
      case 'ble':
        this.renderBleExplorer(main);
        break;
      case 'scan':
        this.scanPage.render(main);
        break;
      case 'speedometer':
        this.speedometerPage.render(main);
        break;
      case 'target-practice':
        this.targetPracticePage.render(main);
        break;
    }
    this.renderSaveIndicator();
    this.renderNotice();
  }

  private renderMisc(main: HTMLElement): void {
    const page = element('section', 'page misc-page');
    const heading = element('div', 'page-heading');
    heading.append(element('h1', '', 'Misc'));
    const list = element('ul', 'misc-feature-list');
    for (const [label, view] of [['Scan', 'scan'], ['Speedometer', 'speedometer'], ['Target Practice', 'target-practice']] as const) {
      const item = element('li');
      const open = button(label, 'misc-feature-button', () => this.setView(view));
      const arrow = element('span', '', '→');
      arrow.setAttribute('aria-hidden', 'true');
      open.append(arrow);
      item.append(open);
      list.append(item);
    }
    page.append(heading, list);
    main.append(page);
  }

  private renderProjects(main: HTMLElement): void {
    const page = element('section', 'page projects-page');
    const headingRow = element('div', 'page-heading');
    const heading = element('div');
    heading.append(element('p', 'eyebrow', 'Project workspace'), element('h1', '', 'Projects'));
    const addButton = button('New project', 'button primary compact', () => this.showProjectDialog());
    headingRow.append(heading, addButton);

    const toolRow = element('div', 'project-tools');
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Find a project';
    search.setAttribute('aria-label', 'Search projects');
    search.value = this.searchTerm;
    search.addEventListener('input', () => {
      this.searchTerm = search.value;
      this.render();
      const replacement = this.root.querySelector<HTMLInputElement>('input[type="search"]');
      replacement?.focus();
      replacement?.setSelectionRange(this.searchTerm.length, this.searchTerm.length);
    });
    const filterButton = button(this.showArchived ? 'Active' : 'Archived', 'button quiet compact', () => {
      this.showArchived = !this.showArchived;
      this.render();
    });
    const importButton = button('Import', 'button quiet compact', () => this.openImportPicker());
    toolRow.append(search, filterButton, importButton);

    const summaries = this.repository.list().filter((summary) => {
      const statusMatches = this.showArchived ? summary.status === 'archived' : summary.status !== 'archived';
      const search = `${summary.name} ${summary.customer} ${summary.address} ${summary.projectNumber}`.toLowerCase();
      return statusMatches && search.includes(this.searchTerm.toLowerCase());
    });
    const list = element('div', 'project-list');

    if (summaries.length === 0) {
      const empty = element('div', 'empty-state');
      empty.append(element('span', 'empty-rule'), element('h2', '', this.searchTerm ? 'No matching projects' : 'Start a measured record'));
      empty.append(element('p', '', this.searchTerm ? 'Try another project name, customer, or address.' : 'Projects are stored on this device. Export a backup regularly to avoid losing your plans.'));
      if (!this.searchTerm && !this.showArchived) empty.append(button('Create first project', 'button primary', () => this.showProjectDialog()));
      list.append(empty);
    } else {
      summaries.forEach((summary) => list.append(this.projectCard(summary)));
    }

    page.append(headingRow, toolRow, list);
    main.append(page);
  }

  private projectCard(summary: ProjectSummary): HTMLElement {
    const card = element('article', 'project-card');
    const top = element('div', 'project-card-top');
    const text = element('div', 'project-card-copy');
    text.append(element('span', 'project-number', summary.projectNumber || 'No project number'));
    text.append(element('h2', '', summary.name));
    text.append(element('p', 'project-customer', summary.customer || summary.address || 'Customer not set'));
    const status = element('span', `status-chip status-${summary.status}`, summary.status);
    top.append(text, status);

    const metrics = element('div', 'project-metrics');
    metrics.append(metric(`${summary.floorCount}`, 'Floors'), metric(`${summary.roomCount}`, 'Rooms'), metric(formatDate(summary.modifiedAt), 'Modified'));
    const actions = element('div', 'card-actions');
    actions.append(button('Open', 'button primary stretch', () => this.openProject(summary.id)));
    actions.append(button('Manage', 'button quiet compact', () => this.showManageDialog(summary.id)));
    card.append(top, metrics, actions);
    return card;
  }

  private renderWorkspace(main: HTMLElement): void {
    const project = this.selectedProject();
    const active = project ? this.activeRoom(project) : null;
    if (!project || !active) {
      this.renderUnavailableView(main, 'Plan', 'Select a project from Projects to open its workspace.');
      return;
    }

    const page = element('section', 'page workspace-page');
    const top = element('div', 'workspace-topbar');
    const identity = element('div');
    identity.append(element('p', 'eyebrow', project.projectNumber || 'Active project'), element('h1', '', project.name));
    const topActions = element('div', 'workspace-actions');
    if (this.layer === 'builder') {
      topActions.append(button('New room', 'button quiet compact', () => this.addRoom(project)));
      topActions.append(button('New Floor', 'button quiet compact', () => this.addFloor(project)));
    }
    topActions.append(button('3D view', 'button primary compact', () => { void this.showRoomViewer(project, this.activeEditor?.getRoom() ?? active); }));
    topActions.append(button('Export', 'button quiet compact', () => this.exportProject(project)));
    top.append(identity, topActions);

    const canvas = element('div', 'plan-canvas');
    const hierarchy = element('div', 'plan-hierarchy');
    hierarchy.append(this.roomSelector(project));
    if (this.layer === 'builder') hierarchy.append(button('Rename', 'button quiet compact', () => this.renameRoom(project, active)), button('Delete', 'button danger compact', () => this.confirmDeleteRoom(project, active)));
    const editor = new FloorPlanEditor({
      room: active,
      units: project.preferredUnits,
      layer: this.layer,
      onChange: (room, completed) => this.updateRoom(project, room, completed),
      onSelection: (selection) => this.updateInspector(selection),
      onMeasure: (wall) => this.showMeasurementDialog(project, active, wall),
      onMeasureObject: (id) => { const room = this.activeRoom(project); if (room) this.showObjectDialog(project, room, id); },
      onMeasureClearance: (id, side) => { const room = this.activeRoom(project); if (room) this.showClearanceDialog(project, room, id, side); },
      onOpening: (kind, id) => this.showOpeningDialog(project, kind, id),
    });
    this.activeEditor = editor;
    const normalizedRoom = editor.getRoom();
    if (JSON.stringify(normalizedRoom) !== JSON.stringify(active)) this.updateRoom(project, normalizedRoom, true);
    if (this.layer === 'builder' && active.walls.length === 0 && active.points.length === 0) this.activeEditor.setTool('room');
    canvas.append(hierarchy, this.activeEditor.element);

    const details = element('section', 'workspace-sheet');
    details.append(element('div', 'sheet-grip'));
    const inspector = element('div', 'editor-inspector');
    details.append(inspector);
    this.editorSelection = null;
    this.renderInspectorContents(inspector, project, active);
    page.append(top, canvas, details);
    main.append(page);
  }

  private roomSelector(project: Project): HTMLSelectElement {
    const select = document.createElement('select');
    select.className = 'room-selector';
    select.setAttribute('aria-label', 'Current room');
    project.buildings.forEach((building) => building.floors.forEach((floor) => floor.rooms.forEach((room) => {
      const option = document.createElement('option');
      option.value = room.id;
      option.textContent = `${building.name} / ${floor.name} / ${room.name}`;
      option.selected = room.id === this.activeRoomId;
      select.append(option);
    })));
    select.addEventListener('change', () => {
      this.activeRoomId = select.value;
      this.editorSelection = null;
      this.render();
    });
    return select;
  }

  private insertObject(definition: ObjectDefinition, projectId: string, roomId: string): void {
    const project = this.repository.get(projectId);
    const room = project?.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.rooms)).find((candidate) => candidate.id === roomId);
    if (!project || !room) {
      this.showToast('Choose a project and room first.');
      return;
    }
    const bounds = partBounds(definition.parts);
    const xs = room.points.map((point) => point.xMeters);
    const ys = room.points.map((point) => point.yMeters);
    const centerX = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0;
    const centerY = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0;
    room.objects.push({
      id: createId(),
      name: definition.name,
      layer: definition.layer ?? 'designer',
      widthMeters: bounds.widthMeters,
      depthMeters: bounds.depthMeters,
      heightMeters: bounds.heightMeters,
      xMeters: centerX - bounds.widthMeters / 2,
      yMeters: centerY - bounds.depthMeters / 2,
      parts: cloneParts(definition.parts),
    });
    project.modifiedAt = new Date().toISOString();
    if (this.save(project)) this.showToast(`Inserted ${definition.name} into ${room.name}. Drag it into place in the project plan.`);
  }

  private activeRoom(project: Project): Room | null {
    const rooms = project.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.rooms));
    const room = rooms.find((candidate) => candidate.id === this.activeRoomId) ?? rooms[0] ?? null;
    if (room) this.activeRoomId = room.id;
    return room;
  }

  private updateRoom(project: Project, changedRoom: Room, completed: boolean): void {
    let roomIndex = 0;
    for (const building of project.buildings) {
      for (const floor of building.floors) {
        roomIndex = floor.rooms.findIndex((room) => room.id === changedRoom.id);
        if (roomIndex >= 0) {
          floor.rooms[roomIndex] = changedRoom;
          project.modifiedAt = new Date().toISOString();
          if (completed) this.save(project);
          else this.scheduleSave(project);
          this.updateInspector(this.editorSelection);
          return;
        }
      }
    }
  }

  private updateInspector(selection: EditorSelection): void {
    this.editorSelection = selection;
    const project = this.selectedProject();
    const room = project ? this.activeRoom(project) : null;
    const inspector = this.root.querySelector<HTMLElement>('.editor-inspector');
    if (project && room && inspector) this.renderInspectorContents(inspector, project, room);
  }

  private renderInspectorContents(inspector: HTMLElement, project: Project, room: Room): void {
    inspector.replaceChildren();
    const openingSelection = this.editorSelection && (this.editorSelection.type === 'door' || this.editorSelection.type === 'window')
      ? { type: this.editorSelection.type, id: this.editorSelection.id }
      : null;
    inspector.append(element('h2', '', this.editorSelection?.type === 'wall' ? 'Wall properties' : this.editorSelection?.type === 'object' ? 'Object properties' : openingSelection ? `${openingSelection.type === 'door' ? 'Door' : 'Window'} properties` : 'Room overview'));
    if (this.editorSelection?.type === 'wall') {
      const wall = room.walls.find((candidate) => candidate.id === this.editorSelection?.id) ?? this.activeEditor?.getSelectedWall();
      if (wall) {
        const length = element('div', 'measurement-readout');
        length.append(element('small', '', 'Current length'), element('strong', '', formatLength(distanceBetween(wall.start, wall.end), project.preferredUnits)));
        const editLength = button('Measure or set length', 'button primary stretch', () => this.showMeasurementDialog(project, room, wall));
        const wallActions = element('div', 'selection-actions');
        wallActions.append(button('Door', 'button quiet', () => this.activeEditor?.addDoorToSelectedWall()));
        wallActions.append(button('Window', 'button quiet', () => this.activeEditor?.addWindowToSelectedWall()));
        wallActions.append(button('Rotate', 'button quiet', () => this.activeEditor?.rotateSelection()));
        wallActions.append(button('Split', 'button quiet', () => this.activeEditor?.splitSelection()));
        wallActions.append(button('Join', 'button quiet', () => this.activeEditor?.joinSelection()));
        wallActions.append(button('Duplicate', 'button quiet', () => this.activeEditor?.duplicateSelection()));
        wallActions.append(button('Copy', 'button quiet', () => this.activeEditor?.copySelection()));
        const lockButton = button(wall.locked ? 'Unlock' : 'Lock', 'button quiet', () => this.activeEditor?.toggleLockSelection());
        wallActions.append(lockButton);
        wallActions.append(button('Delete', 'button danger', () => this.activeEditor?.deleteSelection()));
        inspector.append(length, editLength, this.cornerAngleField(), this.openingList(project), wallActions);
      }
    } else if (this.editorSelection?.type === 'object') {
      const object = room.objects.find((candidate) => candidate.id === this.editorSelection?.id);
      if (object) {
        const readout = element('div', 'measurement-readout');
        const dimensions = [object.widthMeters, object.depthMeters, object.heightMeters].map((value) => formatLength(value, project.preferredUnits)).join(' × ');
        readout.append(element('small', '', `${object.name} · W × D × H`), element('strong', '', dimensions));
        const actions = element('div', 'selection-actions');
        if (!object.wallMount && object.xMeters !== undefined && object.yMeters !== undefined) actions.append(button('Rotate 90°', 'button quiet', () => this.activeEditor?.rotateSelection()));
        actions.append(button('Delete', 'button danger', () => this.activeEditor?.deleteSelection()));
        inspector.append(readout, button('Measure or set size', 'button primary stretch', () => this.showObjectDialog(project, room, object.id)), actions);
        const clearances = this.activeEditor?.getSelectedClearances() ?? [];
        if (clearances.length) {
          const distances = element('div', 'selection-actions');
          for (const clearance of clearances) {
            const label = clearance.side === 'left' || clearance.side === 'right' ? `${clearance.side} wall` : clearance.side;
            distances.append(button(`${label[0].toUpperCase()}${label.slice(1)}: ${formatLength(Math.max(0, clearance.valueMeters), project.preferredUnits)}`, 'button quiet', () => this.showClearanceDialog(project, room, object.id, clearance.side)));
          }
          inspector.append(distances);
        }
        if (object.wallMount) {
          inspector.append(this.wallMountFields(project, object.id, object.wallMount));
          actions.append(button('Remove from wall', 'button quiet', () => this.activeEditor?.detachObjectFromWall(object.id)));
        }
      }
    } else if (openingSelection) {
      const openingType = openingSelection.type;
      const found = this.activeEditor?.getOpening(openingType, openingSelection.id);
      if (found) {
        const readout = element('div', 'measurement-readout');
        const height = found.opening.heightMeters ?? (openingSelection.type === 'door' ? DEFAULT_DOOR_HEIGHT_METERS : DEFAULT_WINDOW_HEIGHT_METERS);
        readout.append(element('small', '', 'Width × height'), element('strong', '', `${formatLength(found.opening.widthMeters, project.preferredUnits)} × ${formatLength(height, project.preferredUnits)}`));
        const actions = element('div', 'selection-actions');
        actions.append(button('Edit segments', 'button primary', () => this.showOpeningDialog(project, openingType, openingSelection.id)));
        actions.append(button('Remove', 'button danger', () => this.activeEditor?.deleteSelection()));
        const help = found.opening.rightWallId
          ? 'This opening separates two independently selectable wall segments.'
          : 'This imported opening uses the compatible overlay model. New openings are split into separate wall segments.';
        inspector.append(readout, element('p', 'inspector-help', help), actions);
      }
    } else {
      const issues = polygonIssues(room.points).filter(() => room.points.length > 0);
      const metrics = element('div', 'room-calculations');
      metrics.append(calculation(formatArea(roomArea(room), project.preferredUnits), 'Area'));
      metrics.append(calculation(formatVolume(roomVolume(room), project.preferredUnits), `Volume at ${formatLength(roomHeight(room), project.preferredUnits)}`));
      metrics.append(calculation(formatArea(wallArea(room.walls, roomHeight(room), openingArea(room.walls, room)), project.preferredUnits), 'Net wall area'));
      inspector.append(metrics);
      if (this.layer === 'builder') {
        if (room.points.length === 4) {
          const rectangularize = button('Make rectangle', 'button primary stretch', () => this.activeEditor?.rectangularizeRoom());
          rectangularize.disabled = !this.activeEditor?.canRectangularizeRoom();
          if (rectangularize.disabled) rectangularize.title = 'Unlock measured walls before changing room geometry.';
          inspector.append(rectangularize);
        }
        inspector.append(this.roomHeightField(project, room));
      }
      else inspector.append(this.objectsSection(project, room));
      if (issues.length) inspector.append(element('p', 'validation-warning', issues.join(' ')));
      if (this.layer === 'builder') inspector.append(element('p', 'inspector-help', 'Choose Wall or Room, then tap or drag on the plan. Use two fingers to pan and pinch to zoom.'));
      if (this.layer === 'builder') inspector.append(this.projectForm(project, 'autosave'));
    }
  }

  private wallMountFields(project: Project, objectId: string, mount: NonNullable<Room['objects'][number]['wallMount']>): HTMLElement {
    const imperial = project.preferredUnits === 'imperial';
    const factor = imperial ? 3.280839895 : 1;
    const section = element('div', 'wall-mount-fields');
    const makeField = (label: string, value: number): HTMLInputElement => {
      const wrapper = element('label', 'field');
      const input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.value = (value * factor).toFixed(imperial ? 2 : 3);
      input.addEventListener('input', () => input.setCustomValidity(''));
      wrapper.append(element('span', 'field-label', `${label} (${imperial ? 'ft' : 'm'})`), input);
      section.append(wrapper);
      return input;
    };
    const offset = makeField('Distance along wall', mount.offsetMeters);
    const height = makeField('Height above floor', mount.elevationMeters);
    section.append(button('Set position', 'button quiet compact', () => {
      if (!this.activeEditor?.updateWallMount(objectId, parseDecimalInput(offset.value) / factor, parseDecimalInput(height.value) / factor)) {
        height.setCustomValidity('Position and object dimensions must fit on the wall.');
        height.reportValidity();
      }
    }));
    return section;
  }

  private cornerAngleField(): HTMLElement {
    const angle = this.activeEditor?.getCornerAngle();
    const group = element('div', 'field');
    if (angle === null || angle === undefined) return group;
    const label = element('span', 'field-label', 'Corner angle at wall end (°)');
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.value = String(Number(angle.toFixed(2)));
    const apply = button('Set angle', 'button quiet compact', () => {
      const degrees = parseDecimalInput(input.value);
      if (!(degrees > 0 && degrees < 360) || !this.activeEditor?.setCornerAngle(degrees)) {
        input.setCustomValidity('Enter an angle between 0 and 360 degrees.');
        input.reportValidity();
      }
    });
    input.addEventListener('input', () => input.setCustomValidity(''));
    group.append(label, input, apply);
    return group;
  }

  private openingList(project: Project): HTMLElement {
    const list = element('div', 'selection-actions');
    for (const { kind, opening } of this.activeEditor?.getWallOpenings() ?? []) {
      list.append(button(`Edit ${kind} (${formatLength(opening.widthMeters, project.preferredUnits)})`, 'button quiet', () => this.showOpeningDialog(project, kind, opening.id)));
    }
    return list;
  }

  private showOpeningDialog(project: Project, kind: 'door' | 'window', id: string): void {
    const found = this.activeEditor?.getOpening(kind, id);
    if (!found) return;
    const imperial = project.preferredUnits === 'imperial';
    const factor = imperial ? 3.280839895 : 1;
    const total = distanceBetween(found.wall.start, found.wall.end);
    const values: Record<OpeningSegmentKey, number> = {
      total,
      before: found.opening.offsetMeters,
      width: found.opening.widthMeters,
      after: Math.max(0, total - found.opening.offsetMeters - found.opening.widthMeters),
    };
    const labels: Record<OpeningSegmentKey, string> = { total: 'Wall length', before: 'Wall before the opening', width: `${kind === 'door' ? 'Door' : 'Window'} width`, after: 'Wall after the opening' };
    const keys: OpeningSegmentKey[] = ['total', 'before', 'width', 'after'];
    // Most recently edited first; the last entry is the derived value.
    const recency: OpeningSegmentKey[] = ['total', 'width', 'before', 'after'];
    const inputs = new Map<OpeningSegmentKey, HTMLInputElement>();
    const content = element('div', 'dialog-content');
    content.append(element('p', 'eyebrow', kind === 'door' ? 'Door' : 'Window'), element('h2', 'dialog-title', 'Wall segments'));
    content.append(element('p', 'measurement-target', `Enter any three values in ${imperial ? 'feet' : 'meters'}; the fourth is calculated.`));
    const format = (meters: number) => (meters * factor).toFixed(imperial ? 2 : 3);
    const refresh = () => {
      const derived = recency[recency.length - 1];
      const entered = { ...values };
      for (const key of keys) if (key !== derived) entered[key] = parseDecimalInput(inputs.get(key)?.value ?? '') / factor;
      Object.assign(values, deriveOpeningSegments(entered, derived));
      for (const key of keys) {
        const input = inputs.get(key);
        if (!input) continue;
        input.readOnly = key === derived;
        input.classList.toggle('is-derived', key === derived);
        if (key === derived) input.value = format(values[key]);
      }
    };
    for (const key of keys) {
      const field = document.createElement('label');
      field.className = 'field';
      const input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.value = format(values[key]);
      input.addEventListener('input', () => {
        input.setCustomValidity('');
        recency.splice(recency.indexOf(key), 1);
        recency.unshift(key);
        refresh();
      });
      inputs.set(key, input);
      field.append(element('span', 'field-label', labels[key]), input);
      content.append(field);
    }
    refresh();
    const heightInput = document.createElement('input');
    heightInput.type = 'text';
    heightInput.inputMode = 'decimal';
    heightInput.value = format(found.opening.heightMeters ?? (kind === 'door' ? DEFAULT_DOOR_HEIGHT_METERS : DEFAULT_WINDOW_HEIGHT_METERS));
    const heightField = document.createElement('label');
    heightField.className = 'field';
    heightField.append(element('span', 'field-label', `${kind === 'door' ? 'Door' : 'Window'} height`), heightInput);
    content.append(heightField);
    const dialog = this.dialog();
    const error = element('p', 'field-error');
    error.setAttribute('role', 'alert');
    content.append(error);
    const actions = element('div', 'dialog-actions');
    actions.append(button('Cancel', 'button quiet', () => dialog.close()));
    actions.append(button('Apply', 'button primary', () => {
      const hasSplitWalls = Boolean(found.opening.rightWallId);
      const valid = keys.every((key) => Number.isFinite(values[key])) && values.total > 0 && values.width > 0
        && (hasSplitWalls ? values.before > 0 && values.after > 0 : values.before >= 0 && values.after >= -1e-9);
      const height = parseDecimalInput(heightInput.value) / factor;
      if (!valid || !(height > 0 && height <= 100) || !this.activeEditor?.updateOpening(kind, id, values.total, values.before, values.width, height)) {
        error.textContent = 'The segments and height must be positive and the segments must add up to the wall length.';
        return;
      }
      dialog.close();
    }));
    content.append(actions);
    dialog.replaceChildren(content);
    this.openDialog(dialog);
  }

  private showMeasurementDialog(project: Project, room: Room, wall: Project['buildings'][number]['floors'][number]['rooms'][number]['walls'][number]): void {
    const dialog = this.dialog();
    const content = element('div', 'dialog-content');
    content.append(element('p', 'eyebrow', 'Manual measurement'), element('h2', 'dialog-title', 'Set wall length'));
    const field = document.createElement('label');
    field.className = 'field';
    const label = element('span', 'field-label', `Length in ${project.preferredUnits === 'imperial' ? 'feet' : 'meters'}`);
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.value = project.preferredUnits === 'imperial' ? (distanceBetween(wall.start, wall.end) * 3.280839895).toFixed(2) : distanceBetween(wall.start, wall.end).toFixed(2);
    field.append(label, input);
    const target = element('p', 'measurement-target', `${room.name} · Selected wall`);
    const actions = element('div', 'dialog-actions');
    actions.append(button('Cancel', 'button quiet', () => dialog.close()));
    actions.append(button('Apply', 'button primary', () => {
      const entered = parseDecimalInput(input.value);
      const meters = project.preferredUnits === 'imperial' ? entered / 3.280839895 : entered;
      if (meters <= 0 || !Number.isFinite(meters)) {
        input.setCustomValidity('Enter a measurement greater than zero.');
        input.reportValidity();
        return;
      }
      const applied = this.activeEditor?.setWallLength(meters, { id: createId(), targetType: 'wall', targetId: wall.id, valueMeters: meters, capturedAt: new Date().toISOString(), source: 'manual' });
      if (applied && this.saveState !== 'error') dialog.close();
    }));
    input.addEventListener('input', () => input.setCustomValidity(''));
    this.measurementPanelContext = { project, room, wall };
    content.append(target, field, this.bluetoothPanel(project, room, wall), actions);
    dialog.replaceChildren(content);
    this.openDialog(dialog);
  }

  private showClearanceDialog(project: Project, room: Room, objectId: string, side: ClearanceSide): void {
    const clearance = this.activeEditor?.getSelectedClearances().find((candidate) => candidate.side === side);
    if (!clearance) return;
    const dialog = this.dialog();
    const content = element('div', 'dialog-content');
    const label = side === 'left' || side === 'right' ? `${side} wall` : side;
    content.append(element('p', 'eyebrow', room.name), element('h2', 'dialog-title', `Distance to ${label}`));
    const field = document.createElement('label');
    field.className = 'field';
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    const factor = project.preferredUnits === 'imperial' ? 3.280839895 : 1;
    input.value = (Math.max(0, clearance.valueMeters) * factor).toFixed(project.preferredUnits === 'imperial' ? 2 : 3);
    field.append(element('span', 'field-label', `Distance in ${project.preferredUnits === 'imperial' ? 'feet' : 'meters'}`), input);
    const error = element('p', 'field-error');
    error.setAttribute('role', 'alert');
    const actions = element('div', 'dialog-actions');
    actions.append(button('Cancel', 'button quiet', () => dialog.close()));
    actions.append(button('Apply', 'button primary', () => {
      const meters = parseDecimalInput(input.value) / factor;
      const applied = this.activeEditor?.applyObjectClearance(side, { id: createId(), targetType: 'other', targetId: objectId, valueMeters: meters, capturedAt: new Date().toISOString(), source: 'manual' });
      if (!applied) {
        error.textContent = 'Enter a positive distance that places the object within the wall and room height.';
        return;
      }
      if (this.saveState !== 'error') dialog.close();
    }));
    this.clearanceMeasurement = { objectId, side, content };
    this.measurementPanelContext = { project, room, clearanceSide: side };
    content.append(field, error, this.bluetoothPanel(project, room, undefined, side), actions);
    dialog.replaceChildren(content);
    this.openDialog(dialog);
  }

  private bluetoothPanel(project: Project, room: Room, wall?: Project['buildings'][number]['floors'][number]['rooms'][number]['walls'][number], clearanceSide?: ClearanceSide, photoTarget?: { label: string; apply: (captureId: string) => void }): HTMLElement {
    const panel = element('section', 'bluetooth-panel');
    panel.dataset.bluetoothPanel = 'true';
    panel.append(element('h3', '', 'Laser measure'));
    const target = photoTarget ? photoTarget.label : clearanceSide ? `${clearanceSide} clearance` : (wall ? 'Selected wall' : 'Active room');
    panel.append(element('p', 'bluetooth-target', `Target: ${room.name} · ${target}`));
    const stateRow = element('div', 'bluetooth-status');
    stateRow.append(element('span', 'bluetooth-state', this.bluetoothStateLabel()), element('span', 'bluetooth-device', this.bluetoothAdapter?.deviceName || this.bluetoothProvider.label));
    panel.append(stateRow);
    if (this.bluetoothDetail) panel.append(element('p', 'bluetooth-detail', this.bluetoothDetail));
    if (this.bluetoothState === 'extension-required' || this.bluetoothProvider.id === 'unsupported') {
      panel.append(element('p', 'bluetooth-help', 'On iPhone and iPad Safari, enable iOSWebBLE. Manual measurements always remain available.'));
    }

    const connectionActions = element('div', 'bluetooth-actions');
    connectionActions.append(button('Connect laser measure', 'button primary stretch', () => { void this.connectLaserMeasure(); }));
    if (this.bluetoothAdapter) {
      connectionActions.append(button('Disconnect', 'button quiet stretch', () => { void this.disconnectLaserMeasure(); }));
    }
    if (this.bluetoothAdapter?.readCurrentMeasurement && this.bluetoothState === 'connected') {
      connectionActions.append(button('Read current measurement', 'button quiet stretch', () => {
        void this.bluetoothAdapter?.readCurrentMeasurement?.().catch((error: unknown) => {
          this.bluetoothDetail = error instanceof Error ? error.message : 'The current measurement could not be read.';
          this.refreshBluetoothSurfaces();
        });
      }));
    }
    panel.append(connectionActions);
    if (!photoTarget) {
      panel.append(button('Configure device', 'button quiet stretch', () => this.showBluetoothSettingsDialog()));
      panel.append(button('Explore device (all services & events)', 'button quiet stretch', () => this.setView('ble')));
    }

    const captures = this.bluetoothCapture.list();
    if (captures.length) {
      const queue = element('div', 'capture-queue');
      for (const capture of captures) {
        const row = element('article', 'capture-row');
        const readout = element('div', 'capture-readout');
        readout.append(element('strong', '', formatLength(capture.valueMeters, project.preferredUnits)));
        readout.append(element('span', '', `#${capture.sequence} · ${capture.deviceName}`));
        readout.append(element('time', '', formatTime(capture.capturedAt)));
        const actions = element('div', 'capture-row-actions');
        actions.append(button('Apply', 'button primary compact', () => {
          if (photoTarget) photoTarget.apply(capture.id);
          else if (clearanceSide) this.applyClearanceCapture(capture.id);
          else this.applyBluetoothCapture(project, room, wall, capture.id);
        }));
        actions.append(button('Retry', 'button quiet compact', () => {
          this.bluetoothCapture.discard(capture.id);
          void this.connectLaserMeasure();
        }));
        actions.append(button('Cancel', 'button quiet compact', () => {
          this.bluetoothCapture.discard(capture.id);
          this.refreshBluetoothSurfaces();
        }));
        row.append(readout, actions);
        queue.append(row);
      }
      panel.append(queue);
    }
    return panel;
  }

  private async connectLaserMeasure(): Promise<void> {
    await this.disconnectLaserMeasure(false);
    const customProfile = loadCustomBoschProfile(localStorage);
    const adapter: LaserMeasureAdapter = new BoschLaserMeasureAdapter(this.bluetoothProvider, customProfile ? [customProfile] : undefined);
    this.bluetoothAdapter = adapter;
    try {
      await adapter.connect(
        (measurement) => this.receiveBluetoothMeasurement(measurement),
        (state, detail) => {
          this.debugLog?.log('bluetooth.state', `${state}${detail ? `: ${detail}` : ''}`);
          this.bluetoothState = state;
          this.bluetoothDetail = detail ?? '';
          this.refreshBluetoothSurfaces();
        },
      );
    } catch (error) {
      this.debugLog?.log('handled.error', error);
      this.bluetoothAdapter = adapter;
      this.refreshBluetoothSurfaces();
    }
  }

  private receiveBluetoothMeasurement(reading: ParsedMeasurement): void {
    const capture = this.bluetoothCapture.receive(reading);
    if (this.dialog().open && this.photoMeasurement?.content.isConnected) {
      this.showToast('Measurement received');
      this.refreshBluetoothSurfaces();
      return;
    }
    if (this.dialog().open && this.clearanceMeasurement?.content.isConnected) {
      this.applyClearanceCapture(capture.id);
      return;
    }
    const selection = this.editorSelection;
    if (this.view === 'plan' && selection && selection.type !== 'room' && this.activeEditor) {
      const applied = this.activeEditor.applySelectedMeasurement({
        id: capture.id,
        targetType: selection.type === 'wall' ? 'wall' : 'other',
        targetId: selection.id,
        valueMeters: capture.valueMeters,
        capturedAt: capture.capturedAt,
        source: 'bluetooth',
        deviceName: capture.deviceName,
      });
      if (applied) {
        this.bluetoothCapture.discard(capture.id);
        this.showToast('Measurement applied');
        this.refreshBluetoothSurfaces();
        return;
      }
      this.showToast('Measurement could not resize the selected item');
    } else {
      this.showToast('Measurement received');
    }
    this.refreshBluetoothSurfaces();
  }

  private applyClearanceCapture(captureId: string): void {
    const context = this.clearanceMeasurement;
    const capture = this.bluetoothCapture.list().find((candidate) => candidate.id === captureId);
    if (!context || !context.content.isConnected || !capture) return;
    const applied = this.activeEditor?.applyObjectClearance(context.side, { id: capture.id, targetType: 'other', targetId: context.objectId, valueMeters: capture.valueMeters, capturedAt: capture.capturedAt, source: 'bluetooth', deviceName: capture.deviceName });
    if (applied) {
      this.bluetoothCapture.discard(capture.id);
      if (this.saveState !== 'error') this.dialog().close();
      this.showToast('Measurement applied');
    } else {
      this.showToast('Measurement does not fit within the wall or room height');
    }
    this.refreshBluetoothSurfaces();
  }

  private async disconnectLaserMeasure(refresh = true): Promise<void> {
    await this.bluetoothAdapter?.disconnect();
    this.bluetoothAdapter = null;
    if (this.bluetoothProvider.id !== 'unsupported') this.bluetoothState = 'ready';
    else this.bluetoothState = this.bluetoothProvider.label === 'iOSWebBLE required' ? 'extension-required' : 'not-available';
    this.bluetoothDetail = '';
    if (refresh) this.refreshBluetoothSurfaces();
  }

  private renderBleExplorer(main: HTMLElement): void {
    const page = element('section', 'page');
    page.append(element('p', 'eyebrow', 'Bluetooth diagnostics'), element('h1', '', 'BLE explorer'));
    page.append(element('p', 'bluetooth-help', 'Pick any nearby device. Every service, characteristic and descriptor is listed, readable values are read, and all notifications/indications are subscribed with decoded payloads logged below. Browsers only expose services declared up front, so add custom service UUIDs if yours is missing.'));
    const wrapper = document.createElement('label');
    wrapper.className = 'field';
    const extra = document.createElement('input');
    extra.type = 'text';
    extra.autocomplete = 'off';
    extra.placeholder = 'Extra service UUIDs, comma separated';
    extra.value = loadExtraServices(localStorage);
    wrapper.append(element('span', 'field-label', 'Additional service UUIDs'), extra);
    const output = document.createElement('pre');
    output.className = 'bluetooth-log';
    output.style.cssText = 'max-height:50vh;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:11px;user-select:text';
    output.textContent = this.explorerLog.join('\n');
    const append = (line: string) => {
      this.debugLog?.log('bluetooth.explorer', line);
      this.explorerLog.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
      if (!output.isConnected) return;
      output.textContent = this.explorerLog.join('\n');
      output.scrollTop = output.scrollHeight;
    };
    const stop = () => {
      this.deviceExplorer?.disconnect();
      this.deviceExplorer = null;
    };
    const actions = element('div', 'bluetooth-actions');
    actions.append(button('Scan & connect', 'button primary stretch', () => {
      stop();
      saveExtraServices(localStorage, extra.value);
      const explorer = new DeviceExplorer(this.bluetoothProvider, append, () => { this.deviceExplorer = null; });
      this.deviceExplorer = explorer;
      void explorer.start(extra.value).then(() => append('Discovery complete. Trigger a measurement on the device now.'), (error: unknown) => append(`ERROR ${error instanceof Error ? error.message : String(error)}`));
    }));
    actions.append(button('Copy log', 'button quiet stretch', () => {
      void navigator.clipboard?.writeText(this.explorerLog.join('\n')).then(() => this.showToast('Log copied'), () => this.showToast('Copy failed'));
    }));
    actions.append(button('Clear log', 'button quiet stretch', () => { this.explorerLog = []; output.textContent = ''; }));
    actions.append(button('Disconnect', 'button quiet stretch', () => { stop(); append('Disconnected by user.'); }));
    actions.append(button('Back', 'button quiet stretch', () => { stop(); this.setView('more'); }));
    page.append(wrapper, actions, output);
    main.append(page);
  }

  private showBluetoothSettingsDialog(): void {
    const saved = loadCustomBoschProfileSettings(localStorage);
    const dialog = this.dialog();
    const content = element('div', 'dialog-content');
    content.append(element('p', 'eyebrow', 'Advanced Bluetooth'), element('h2', 'dialog-title', 'Laser measure profile'));
    content.append(element('p', 'bluetooth-help', 'Enter the BLE identifiers and payload layout published for your Bosch model.'));

    const field = (label: string, value: string, placeholder = '') => {
      const wrapper = document.createElement('label');
      wrapper.className = 'field';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value;
      input.placeholder = placeholder;
      input.autocomplete = 'off';
      wrapper.append(element('span', 'field-label', label), input);
      return { wrapper, input };
    };
    const displayName = field('Device label', saved?.displayName ?? 'Bosch laser measure', 'Bosch GLM 50-27 C');
    const namePrefix = field('Bluetooth name prefix', saved?.namePrefix ?? '', 'Bosch GLM');
    const serviceUuid = field('Service UUID', saved?.serviceUuid ?? '', '0000180f-0000-1000-8000-00805f9b34fb');
    const characteristicUuid = field('Measurement characteristic UUID', saved?.measurementCharacteristicUuid ?? '', '00002a19-0000-1000-8000-00805f9b34fb');
    const payloadWrapper = document.createElement('label');
    payloadWrapper.className = 'field';
    const payloadFormat = document.createElement('select');
    payloadFormat.className = 'room-selector';
    const formats: Array<[BoschPayloadFormat, string]> = [
      ['bosch-glm20', 'Bosch GLM logging protocol (20-byte packets)'],
      ['float32-le-m', '32-bit float, little-endian, meters'],
      ['uint32-le-mm', '32-bit unsigned integer, little-endian, millimeters'],
      ['uint32-le-0.1mm', '32-bit unsigned integer, little-endian, 0.1 millimeters'],
      ['uint16-le-mm', '16-bit unsigned integer, little-endian, millimeters'],
    ];
    for (const [value, label] of formats) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = value === saved?.payloadFormat;
      payloadFormat.append(option);
    }
    payloadWrapper.append(element('span', 'field-label', 'Measurement payload format'), payloadFormat);
    const byteOffset = field('Measurement byte offset', String(saved?.byteOffset ?? 0), '0');
    byteOffset.input.inputMode = 'numeric';
    const error = element('p', 'field-error');
    error.setAttribute('role', 'alert');
    content.append(displayName.wrapper, namePrefix.wrapper, serviceUuid.wrapper, characteristicUuid.wrapper, payloadWrapper, byteOffset.wrapper, error);

    const actions = element('div', 'dialog-actions stacked');
    actions.append(button('Cancel', 'button quiet', () => dialog.close()));
    if (saved) actions.append(button('Remove profile', 'button danger', () => {
      clearCustomBoschProfile(localStorage);
      void this.disconnectLaserMeasure(false);
      dialog.close();
      this.render();
      this.showToast('Bluetooth device profile removed');
    }));
    actions.append(button('Save profile', 'button primary', () => {
      try {
        saveCustomBoschProfile(localStorage, {
          displayName: displayName.input.value,
          namePrefix: namePrefix.input.value,
          serviceUuid: serviceUuid.input.value,
          measurementCharacteristicUuid: characteristicUuid.input.value,
          payloadFormat: payloadFormat.value as BoschPayloadFormat,
          byteOffset: parseInt(byteOffset.input.value, 10),
        });
        void this.disconnectLaserMeasure(false);
        dialog.close();
        this.render();
        this.showToast('Bluetooth device profile saved');
      } catch (settingsError) {
        this.debugLog?.log('handled.error', settingsError);
        error.textContent = settingsError instanceof Error ? settingsError.message : 'The Bluetooth profile is invalid.';
      }
    }));
    content.append(actions);
    dialog.replaceChildren(content);
    this.openDialog(dialog);
  }

  private bluetoothStateLabel(): string {
    const labels: Record<BluetoothConnectionState, string> = {
      'not-available': 'Not available',
      'extension-required': 'Extension required',
      ready: 'Ready',
      searching: 'Searching',
      connecting: 'Connecting',
      connected: 'Connected',
      receiving: 'Receiving measurement',
      disconnected: 'Disconnected',
      error: 'Error',
    };
    return labels[this.bluetoothState];
  }

  private refreshBluetoothSurfaces(): void {
    if (this.dialog().open && this.photoMeasurement?.content.isConnected) {
      this.photoMeasurement.refresh();
      return;
    }
    const panel = this.dialog().open ? this.dialog().querySelector<HTMLElement>('[data-bluetooth-panel]') : null;
    if (this.measurementPanelContext && panel) {
      const { project, room, wall, clearanceSide } = this.measurementPanelContext;
      panel.replaceWith(this.bluetoothPanel(project, room, wall, clearanceSide));
      return;
    }
    if (this.view === 'measure') this.render();
  }

  private applyBluetoothCapture(project: Project, room: Room, wall: Project['buildings'][number]['floors'][number]['rooms'][number]['walls'][number] | undefined, captureId: string): void {
    const measurement = this.bluetoothCapture.confirm(captureId, room, wall ? 'wall' : 'room', wall?.id ?? room.id);
    if (!measurement) return;
    if (wall) {
      const previousEnd = { ...wall.end };
      const angle = Math.atan2(previousEnd.yMeters - wall.start.yMeters, previousEnd.xMeters - wall.start.xMeters);
      wall.end = {
        xMeters: wall.start.xMeters + Math.cos(angle) * measurement.valueMeters,
        yMeters: wall.start.yMeters + Math.sin(angle) * measurement.valueMeters,
      };
      wall.lengthMeters = measurement.valueMeters;
      room.points = room.points.map((point) => point.xMeters === previousEnd.xMeters && point.yMeters === previousEnd.yMeters ? { ...wall.end } : point);
    }
    project.modifiedAt = new Date().toISOString();
    if (this.save(project)) {
      if (wall && this.dialog().open) this.dialog().close();
      this.showToast('Measurement applied');
      this.render();
    }
  }

  private addRoom(project: Project): void {
    const floors = project.buildings.flatMap((building) => building.floors);
    const floor = floors.find((candidate) => candidate.rooms.some((room) => room.id === this.activeRoomId)) ?? floors[0];
    if (!floor) return;
    const room = createRoom(`Room ${floor.rooms.length + 1}`);
    floor.rooms.push(room);
    this.activeRoomId = room.id;
    project.modifiedAt = new Date().toISOString();
    if (this.save(project)) this.render();
  }

  private confirmDeleteRoom(project: Project, room: Room): void {
    const rooms = project.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.rooms));
    if (rooms.length <= 1) {
      this.showToast('A project needs at least one room');
      return;
    }
    const dialog = this.dialog();
    const content = element('div', 'dialog-content');
    content.append(element('p', 'eyebrow', 'Room details'), element('h2', 'dialog-title', 'Delete room?'));
    content.append(element('p', 'measurement-target', `"${room.name}" and its walls, measurements, photos and notes will be removed.`));
    const actions = element('div', 'dialog-actions');
    actions.append(button('Cancel', 'button quiet', () => dialog.close()));
    actions.append(button('Delete room', 'button danger', () => {
      if (this.deleteRoom(project, room.id)) dialog.close();
    }));
    content.append(actions);
    dialog.replaceChildren(content);
    this.openDialog(dialog);
  }

  private deleteRoom(project: Project, roomId: string): boolean {
    const rooms = project.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.rooms));
    if (rooms.length <= 1) return false;
    const next = rooms[(rooms.findIndex((room) => room.id === roomId) + 1) % rooms.length];
    for (const building of project.buildings) {
      for (const floor of building.floors) floor.rooms = floor.rooms.filter((room) => room.id !== roomId);
    }
    this.activeRoomId = next.id;
    this.editorSelection = null;
    project.modifiedAt = new Date().toISOString();
    if (!this.save(project)) return false;
    this.render();
    return true;
  }

  private roomHeightField(project: Project, room: Room): HTMLElement {
    const imperial = project.preferredUnits === 'imperial';
    const factor = imperial ? 3.280839895 : 1;
    const group = element('div', 'field');
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.value = (roomHeight(room) * factor).toFixed(imperial ? 2 : 3);
    input.addEventListener('input', () => input.setCustomValidity(''));
    const apply = button('Set height', 'button quiet compact', () => {
      const meters = parseDecimalInput(input.value) / factor;
      if (!(meters >= 0.1 && meters <= 100)) {
        input.setCustomValidity('Enter a valid room height.');
        input.reportValidity();
        return;
      }
      room.heightMeters = meters;
      project.modifiedAt = new Date().toISOString();
      if (this.save(project)) this.render();
    });
    group.append(element('span', 'field-label', `Room height (${imperial ? 'ft' : 'm'})`), input, apply);
    return group;
  }

  private objectsSection(project: Project, room: Room): HTMLElement {
    const section = element('section', 'room-objects');
    section.append(element('h3', '', 'Objects'));
    const objects = room.objects.filter((object) => (object.layer ?? 'designer') === this.layer);
    if (!objects.length) section.append(element('p', 'measurements-empty', 'No objects in this room yet.'));
    for (const object of objects) {
      const row = element('div', 'room-note');
      const dimensions = [object.widthMeters, object.depthMeters, object.heightMeters].map((value) => formatLength(value, project.preferredUnits)).join(' × ');
      row.append(element('span', '', `${object.name} · ${dimensions}`));
      row.append(button('Edit', 'button quiet compact', () => this.showObjectDialog(project, room, object.id)));
      row.append(button('Remove', 'button quiet compact', () => {
        room.objects = room.objects.filter((candidate) => candidate.id !== object.id);
        project.modifiedAt = new Date().toISOString();
        if (this.save(project)) this.render();
      }));
      section.append(row);
    }
    section.append(button('Draw object', 'button quiet stretch', () => this.activeEditor?.setTool('object')));
    return section;
  }

  private showObjectDialog(project: Project, room: Room, objectId: string): void {
    const existing = room.objects.find((candidate) => candidate.id === objectId);
    if (!existing || (existing.layer ?? 'designer') !== this.layer) return;
    const imperial = project.preferredUnits === 'imperial';
    const factor = imperial ? 3.280839895 : 1;
    const dialog = this.dialog();
    const content = element('div', 'dialog-content');
    content.append(element('p', 'eyebrow', room.name), element('h2', 'dialog-title', 'Object size'));
    const field = (label: string, numeric: boolean, value: string) => {
      const wrapper = document.createElement('label');
      wrapper.className = 'field';
      const input = document.createElement('input');
      input.type = 'text';
      if (numeric) input.inputMode = 'decimal';
      input.value = value;
      wrapper.append(element('span', 'field-label', label), input);
      content.append(wrapper);
      return input;
    };
    const unit = imperial ? 'ft' : 'm';
    const shown = (meters: number) => (meters * factor).toFixed(imperial ? 2 : 3);
    const name = field('Name', false, existing.name);
    const width = field(`Width (${unit})`, true, shown(existing.widthMeters));
    const depth = field(`Depth (${unit})`, true, shown(existing.depthMeters));
    const height = field(`Height (${unit})`, true, shown(existing.heightMeters));
    const error = element('p', 'field-error');
    error.setAttribute('role', 'alert');
    const actions = element('div', 'dialog-actions');
    actions.append(button('Cancel', 'button quiet', () => dialog.close()));
    actions.append(button('Apply', 'button primary', () => {
      const [widthMeters, depthMeters, heightMeters] = [width, depth, height].map((input) => parseDecimalInput(input.value) / factor);
      if (!name.value.trim() || ![widthMeters, depthMeters, heightMeters].every((value) => value > 0 && value <= 1000)) {
        error.textContent = 'Enter a name and positive width, depth and height.';
        return;
      }
      const measurement = { id: createId(), targetType: 'other' as const, targetId: objectId, valueMeters: widthMeters, capturedAt: new Date().toISOString(), source: 'manual' as const };
      if (!this.activeEditor?.updateObject(objectId, { name: name.value.trim(), widthMeters, depthMeters, heightMeters }, measurement)) {
        error.textContent = 'The object must fit within its wall and room height.';
        return;
      }
      if (this.saveState !== 'error') dialog.close();
    }));
    content.append(error, actions);
    dialog.replaceChildren(content);
    this.openDialog(dialog);
  }

  private addFloor(project: Project): void {
    const building = project.buildings[0];
    if (!building) return;
    const floorNumber = building.floors.length;
    const floor = { id: createId(), name: `Floor ${floorNumber}`, level: floorNumber, rooms: [createRoom()] };
    building.floors.push(floor);
    this.activeRoomId = floor.rooms[0].id;
    project.modifiedAt = new Date().toISOString();
    if (this.save(project)) this.render();
  }

  private renameRoom(project: Project, room: Room): void {
    const dialog = this.dialog();
    const content = element('div', 'dialog-content');
    content.append(element('p', 'eyebrow', 'Room details'), element('h2', 'dialog-title', 'Rename room'));
    const field = document.createElement('label');
    field.className = 'field';
    const input = document.createElement('input');
    input.value = room.name;
    input.required = true;
    field.append(element('span', 'field-label', 'Room name'), input);
    const actions = element('div', 'dialog-actions');
    actions.append(button('Cancel', 'button quiet', () => dialog.close()));
    actions.append(button('Save', 'button primary', () => {
      if (!input.reportValidity()) return;
      room.name = input.value.trim();
      project.modifiedAt = new Date().toISOString();
      if (this.save(project)) {
        dialog.close();
        this.render();
      }
    }));
    content.append(field, actions);
    dialog.replaceChildren(content);
    this.openDialog(dialog);
  }

  private projectForm(project: Project, mode: 'autosave' | 'dialog'): HTMLFormElement {
    const form = element('form', 'project-form');
    const fields: Array<['name' | 'projectNumber' | 'customer' | 'address', string, string, string]> = [
      ['name', 'Project name', 'text', 'Required'],
      ['projectNumber', 'Project number', 'text', 'Optional'],
      ['customer', 'Customer', 'text', 'Optional'],
      ['address', 'Address', 'text', 'Optional'],
    ];
    for (const [key, labelText, type, hint] of fields) {
      const label = document.createElement('label');
      label.className = 'field';
      const title = element('span', 'field-label', labelText);
      const input = document.createElement('input');
      input.type = type;
      input.name = key;
      input.value = project[key];
      input.required = key === 'name';
      input.autocomplete = key === 'name' ? 'off' : 'street-address';
      input.placeholder = hint;
      if (mode === 'autosave') {
        input.addEventListener('input', () => {
          const value = input.value;
          (project[key] as string) = value;
          project.modifiedAt = new Date().toISOString();
          this.scheduleSave(project);
          const pageTitle = this.root.querySelector<HTMLElement>('.workspace-topbar h1');
          if (key === 'name' && pageTitle) pageTitle.textContent = value;
        });
      }
      label.append(title, input);
      form.append(label);
    }

    const descriptionLabel = document.createElement('label');
    descriptionLabel.className = 'field field-wide';
    const descriptionTitle = element('span', 'field-label', 'Description');
    const description = document.createElement('textarea');
    description.name = 'description';
    description.rows = 3;
    description.value = project.description;
    if (mode === 'autosave') {
      description.addEventListener('input', () => {
        project.description = description.value;
        project.modifiedAt = new Date().toISOString();
        this.scheduleSave(project);
      });
    }
    descriptionLabel.append(descriptionTitle, description);
    form.append(descriptionLabel);
    return form;
  }

  private renderMeasurements(main: HTMLElement): void {
    const project = this.selectedProject();
    const page = element('section', 'page measurements-page');
    page.append(element('p', 'eyebrow', 'Project record'), element('h1', '', 'Measurements'));
    if (!project) {
      page.append(element('p', 'measurements-empty', 'Open a project, then select a wall and use Measure to add a value.'));
      page.append(button('Browse projects', 'button primary', () => this.setView('projects')));
      main.append(page);
      return;
    }
    const measurements = project.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.rooms.flatMap((room) => room.measurements.map((measurement) => ({ measurement, room, building, floor })))))
      .sort((left, right) => right.measurement.capturedAt.localeCompare(left.measurement.capturedAt));
    const list = element('div', 'measurement-list');
    if (!measurements.length) {
      list.append(element('p', 'measurements-empty', 'No measurements yet. Select a wall in Plan and choose Measure.'));
    }
    for (const { measurement, room, building, floor } of measurements) {
      const row = element('article', 'measurement-row');
      row.append(element('strong', 'measurement-value', formatLength(measurement.valueMeters, project.preferredUnits)));
      const target = measurementTargetLabel(room, measurement);
      const device = measurement.deviceName ? ` · ${measurement.deviceName}` : '';
      row.append(element('span', '', `${building.name} / ${floor.name} / ${room.name} · ${target} · ${measurement.source}${device} · ${formatDate(measurement.capturedAt)}`));
      list.append(row);
    }
    const active = this.activeRoom(project);
    const selectedWall = this.editorSelection?.type === 'wall'
      ? active?.walls.find((wall) => wall.id === this.editorSelection?.id)
      : undefined;
    if (active) page.append(list, this.bluetoothPanel(project, active, selectedWall), button('Open plan', 'button quiet stretch', () => this.setView('plan')));
    else page.append(list, button('Open plan', 'button quiet stretch', () => this.setView('plan')));
    main.append(page);
  }

  private renderMore(main: HTMLElement): void {
    const page = element('section', 'page settings-page');
    page.append(element('p', 'eyebrow', 'Local workspace'), element('h1', '', 'More'));
    const usage = this.repository.getStorageUsage();
    const storage = element('section', 'settings-section');
    storage.append(element('h2', '', 'Device storage'));
    const meter = document.createElement('progress');
    meter.max = 1;
    meter.value = usage.percentUsed ?? 0;
    meter.setAttribute('aria-label', 'Local storage used');
    storage.append(meter, element('p', '', `${formatBytes(usage.bytesUsed)} of approximately ${formatBytes(usage.quotaBytes ?? 0)} used`));
    if ((usage.percentUsed ?? 0) >= 0.7) storage.append(element('p', 'storage-warning', 'Device storage is above 70%. Export projects and remove unneeded photos to avoid save failures.'));
    storage.append(element('p', 'storage-warning', 'Clearing Safari website data can delete local projects. Export important projects regularly.'));
    const bluetooth = element('section', 'settings-section');
    bluetooth.append(element('h2', '', 'Bluetooth setup'));
    const configuredProfile = loadCustomBoschProfileSettings(localStorage);
    bluetooth.append(element('p', '', configuredProfile ? `${configuredProfile.displayName} is configured for ${this.bluetoothProvider.label}.` : 'No real-device profile is configured. Simulation remains available.'));
    bluetooth.append(button('BLE explorer', 'button quiet stretch', () => this.setView('ble')));
    bluetooth.append(button(configuredProfile ? 'Edit device profile' : 'Configure laser measure', 'button quiet stretch', () => this.showBluetoothSettingsDialog()));
    const debug = element('section', 'settings-section');
    debug.append(element('h2', '', 'Debug recording'));
    if (this.debugLog) {
      const session = this.debugLog.current;
      const toggle = document.createElement('label');
      toggle.className = 'debug-toggle';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = session?.enabled ?? false;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) this.debugLog?.start();
        else this.debugLog?.stop();
        this.render();
      });
      toggle.append(checkbox, element('span', '', 'Enable debug recording'));
      debug.append(toggle);
      debug.append(element('p', '', session?.enabled ? 'Recording is active.' : session ? `Recording stopped. ${session.entries.length} entries saved.` : 'No recording yet.'));
      debug.append(element('p', '', 'Starting a new recording replaces the previous log. Logs may contain sensitive information; review before sharing.'));
      if (session?.dropped) debug.append(element('p', 'storage-warning', `${session.dropped} older entries were removed to limit storage use.`));
      if (this.debugLog.hasStorageError) debug.append(element('p', 'storage-warning', 'The debug log could not be saved to device storage. Export it before closing this page.'));
      if (session && !session.enabled) {
        debug.append(button('View debug log', 'button quiet stretch', () => this.showDebugLog()));
        debug.append(button('Export debug log', 'button quiet stretch', () => this.exportDebugLog()));
      }
    }
    const actions = element('section', 'settings-section');
    actions.append(element('h2', '', 'Project files and reports'));
    actions.append(button('Import project', 'button primary stretch', () => this.openImportPicker()));
    actions.append(button('Export full backup', 'button quiet stretch', () => {
      const projects = this.repository.list().flatMap((summary) => {
        const project = this.repository.get(summary.id);
        return project ? [project] : [];
      });
      this.downloadText(serializeBackup(projects), `sitemeasure-backup-${new Date().toISOString().slice(0, 10)}.sitemeasure-backup.json`, 'application/json');
    }));
    actions.append(button('Restore full backup', 'button quiet stretch', () => this.openBackupPicker()));
    const current = this.selectedProject();
    if (current) {
      const room = this.activeRoom(current);
      actions.append(button('Export open project', 'button quiet stretch', () => this.exportProject(current)));
      actions.append(button('Export without photos', 'button quiet stretch', () => this.exportProject(current, false)));
      actions.append(button('Export measurements CSV', 'button quiet stretch', () => this.downloadText(measurementsCsv(current), `${safeFilename(current.name)}-measurements.csv`, 'text/csv')));
      if (room) {
        actions.append(button('Export room SVG', 'button quiet stretch', () => this.downloadText(floorPlanSvg(current, room), `${safeFilename(room.name)}-plan.svg`, 'image/svg+xml')));
        actions.append(button('Export room PNG', 'button quiet stretch', () => { void this.exportRoomPng(current, room); }));
      }
      actions.append(button('Print project report', 'button quiet stretch', () => this.printReport(current)));
    }
    page.append(storage, bluetooth, debug, actions);
    main.append(page);
  }

  private showDebugLog(): void {
    const session = this.debugLog?.current;
    if (!session) return;
    const dialog = this.dialog();
    const content = element('div', 'dialog-content');
    const title = element('h2', 'dialog-title', 'Debug log');
    title.id = 'dialog-title';
    const log = element('pre', 'debug-log');
    log.textContent = session.entries.map((entry) => `${entry.time} ${entry.type}\n${entry.detail}`).join('\n\n');
    const copyStatus = element('p', 'bluetooth-detail');
    copyStatus.setAttribute('role', 'status');
    const actions = element('div', 'dialog-actions');
    actions.append(button('Copy log', 'button quiet', () => {
      const selectLog = () => {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(log);
        selection?.removeAllRanges();
        selection?.addRange(range);
        copyStatus.textContent = 'Log selected. Use your device copy command.';
      };
      if (!navigator.clipboard?.writeText) { selectLog(); return; }
      void navigator.clipboard.writeText(log.textContent ?? '').then(() => {
        copyStatus.textContent = 'Log copied.';
      }, selectLog);
    }), button('Export', 'button primary', () => this.exportDebugLog()), button('Close', 'button quiet', () => dialog.close()));
    content.append(title, element('p', '', `${session.entries.length} entries${session.dropped ? `; ${session.dropped} older entries removed` : ''}`), log, copyStatus, actions);
    dialog.replaceChildren(content);
    this.openDialog(dialog);
  }

  private exportDebugLog(): void {
    const session = this.debugLog?.current;
    if (session) this.downloadText(JSON.stringify(session, null, 2), `sitemeasure-debug-${session.startedAt.replace(/[:.]/g, '-')}.json`, 'application/json');
  }

  private renderPhotos(main: HTMLElement): void {
    const project = this.selectedProject();
    const room = project ? this.activeRoom(project) : null;
    const page = element('section', 'page photos-page');
    const heading = element('div', 'page-heading');
    const identity = element('div');
    identity.append(element('p', 'eyebrow', 'Project record'), element('h1', '', 'Photos'));
    heading.append(identity);
    if (project && room) {
      heading.append(button('Add photo', 'button primary compact', () => this.showPhotoSourceDialog(project, room)));
    }
    page.append(heading);
    if (!project || !room) {
      page.append(element('p', 'measurements-empty', 'Open a project before adding site photos and room notes.'));
      page.append(button('Browse projects', 'button primary', () => this.setView('projects')));
      main.append(page);
      return;
    }

    page.append(this.roomSelector(project));
    const notes = element('section', 'room-notes');
    notes.append(element('h2', '', `${room.name} notes`));
    const noteInput = document.createElement('textarea');
    noteInput.placeholder = 'Add a room note';
    noteInput.rows = 2;
    noteInput.setAttribute('aria-label', 'New room note');
    const addNote = button('Add note', 'button quiet compact', () => {
      const value = noteInput.value.trim();
      if (!value) return;
      room.notes.push(value);
      project.modifiedAt = new Date().toISOString();
      if (this.save(project)) this.render();
    });
    notes.append(noteInput, addNote);
    for (const [index, note] of room.notes.entries()) {
      const row = element('div', 'room-note');
      row.append(element('p', '', note), button('Delete', 'button quiet compact', () => {
        room.notes.splice(index, 1);
        project.modifiedAt = new Date().toISOString();
        if (this.save(project)) this.render();
      }));
      notes.append(row);
    }
    page.append(notes);

    const grid = element('div', 'photo-grid');
    if (!room.photos.length) grid.append(element('p', 'measurements-empty', 'No photos yet. Add a camera capture or select an image from your library.'));
    room.photos.slice().sort((left, right) => right.capturedAt.localeCompare(left.capturedAt)).forEach((photo) => {
      const card = element('button', 'photo-card');
      card.type = 'button';
      const image = document.createElement('img');
      image.src = photo.dataUrl;
      image.alt = photo.title;
      const text = element('span', 'photo-card-copy');
      text.append(element('strong', '', photo.title), element('small', '', `${formatBytes(photo.sizeBytes)} · ${photo.annotations.length} annotations`));
      card.append(image, text);
      card.addEventListener('click', () => this.showPhotoDialog(project, room, photo));
      grid.append(card);
    });
    page.append(grid);
    main.append(page);
  }

  private showPhotoSourceDialog(project: Project, room: Room): void {
    const dialog = this.dialog();
    const content = element('div', 'dialog-content');
    content.append(element('p', 'eyebrow', room.name), element('h2', 'dialog-title', 'Add site photo'));
    const actions = element('div', 'manage-actions');
    actions.append(button('Take photo', 'button primary stretch', () => this.root.querySelector<HTMLInputElement>('[data-photo-camera]')?.click()));
    actions.append(button('Choose from library', 'button quiet stretch', () => this.root.querySelector<HTMLInputElement>('[data-photo-library]')?.click()));
    actions.append(button('Cancel', 'button quiet stretch', () => dialog.close()));
    content.append(actions);
    dialog.replaceChildren(content);
    this.openDialog(dialog);
    if (!project || !room) dialog.close();
  }

  private async handlePhoto(file: File | undefined, input: HTMLInputElement): Promise<void> {
    const project = this.selectedProject();
    const room = project ? this.activeRoom(project) : null;
    if (!file || !project || !room) return;
    const dialog = this.dialog();
    const processingStatus = element('p', 'bluetooth-detail', 'Processing photo…');
    processingStatus.dataset.photoProcessing = 'true';
    dialog.querySelector('.dialog-content')?.append(processingStatus);
    try {
      const photo = await processPhoto(file);
      this.showProcessedPhotoConfirmation(project, room, photo);
    } catch (error) {
      this.debugLog?.log('handled.error', error);
      const message = error instanceof Error ? error.message : 'The photo could not be processed.';
      processingStatus.textContent = `${message} Choose another photo to try again.`;
      this.showToast(message);
    } finally {
      input.value = '';
    }
  }

  private showProcessedPhotoConfirmation(project: Project, room: Room, photo: ProjectPhoto): void {
    const dialog = this.dialog();
    const content = element('div', 'dialog-content photo-confirmation');
    content.append(element('p', 'eyebrow', 'Photo processed'), element('h2', 'dialog-title', 'Review site photo'));
    const image = document.createElement('img');
    image.src = photo.dataUrl;
    image.alt = photo.title;
    content.append(image, element('p', 'photo-result-size', `${photo.width} × ${photo.height} px · approximately ${formatBytes(photo.sizeBytes)}`));
    const title = document.createElement('input');
    title.value = photo.title;
    title.setAttribute('aria-label', 'Photo title');
    const actions = element('div', 'dialog-actions');
    actions.append(button('Cancel', 'button quiet', () => dialog.close()));
    actions.append(button('Save photo', 'button primary', () => {
      photo.title = title.value.trim() || 'Site photo';
      room.photos.push(photo);
      project.modifiedAt = new Date().toISOString();
      if (this.save(project)) {
        dialog.close();
        this.showToast(`Photo saved · ${formatBytes(photo.sizeBytes)}`);
        this.render();
      }
    }));
    content.append(title, actions);
    dialog.replaceChildren(content);
    this.openDialog(dialog);
  }

  private showPhotoDialog(project: Project, room: Room, photo: ProjectPhoto): void {
    const dialog = this.dialog();
    const originalPhoto = structuredClone(photo);
    const content = element('div', 'dialog-content photo-editor');
    content.append(element('p', 'eyebrow', 'Photo annotation'), element('h2', 'dialog-title', photo.title));
    const titleField = document.createElement('input');
    titleField.value = photo.title;
    titleField.setAttribute('aria-label', 'Photo title');
    const notes = document.createElement('textarea');
    notes.value = photo.notes;
    notes.rows = 3;
    notes.placeholder = 'Photo notes';
    notes.setAttribute('aria-label', 'Photo notes');
    const textInput = document.createElement('input');
    textInput.placeholder = 'Annotation text';
    textInput.setAttribute('aria-label', 'Annotation text');
    const stage = element('div', 'photo-stage');
    const image = document.createElement('img');
    image.src = photo.dataUrl;
    image.alt = photo.title;
    image.draggable = false;
    stage.append(image);
    let tool: PhotoAnnotation['type'] = 'arrow';
    let selectedId = photo.annotations.at(-1)?.id ?? '';
    const updateAnnotations = () => {
      const rendered = renderPhotoAnnotations(image, photo.annotations, project.preferredUnits, selectedId);
      const current = stage.querySelector('svg');
      if (current) current.replaceWith(rendered);
      else stage.append(rendered);
    };
    image.addEventListener('load', updateAnnotations);
    const annotationSelect = document.createElement('select');
    annotationSelect.setAttribute('aria-label', 'Photo annotation');
    const dimensionSelect = document.createElement('select');
    dimensionSelect.setAttribute('aria-label', 'Annotation dimension');
    const dimensionInput = document.createElement('input');
    dimensionInput.type = 'text';
    dimensionInput.inputMode = 'decimal';
    dimensionInput.setAttribute('aria-label', `Dimension in ${project.preferredUnits === 'imperial' ? 'feet' : 'meters'}`);
    const dimensionStatus = element('p', 'bluetooth-detail');
    const measurementSection = element('section', 'photo-measurement');
    const selectedAnnotation = () => photo.annotations.find((annotation) => annotation.id === selectedId);
    const dimensionKey = () => dimensionSelect.value as 'lengthMeters' | 'widthMeters' | 'heightMeters';
    const refreshDimension = () => {
      const annotation = selectedAnnotation();
      const previousDimension = dimensionSelect.value;
      dimensionSelect.replaceChildren();
      const dimensions: Array<[string, string]> = [];
      if (annotation?.type === 'arrow') dimensions.push(['lengthMeters', 'Length']);
      else if (annotation && annotation.type !== 'text') dimensions.push(['widthMeters', 'Width'], ['heightMeters', 'Height']);
      for (const [value, label] of dimensions) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        dimensionSelect.append(option);
      }
      if (dimensions.some(([value]) => value === previousDimension)) dimensionSelect.value = previousDimension;
      const value = annotation && annotation.type !== 'text' ? annotation[dimensionKey()] : undefined;
      const factor = project.preferredUnits === 'imperial' ? 3.280839895 : 1;
      dimensionInput.value = value === undefined ? '' : (value * factor).toFixed(3);
      dimensionInput.disabled = !annotation;
      dimensionSelect.disabled = !annotation;
      dimensionStatus.textContent = '';
    };
    const refreshSelection = () => {
      annotationSelect.replaceChildren();
      for (const [index, annotation] of photo.annotations.entries()) {
        const option = document.createElement('option');
        option.value = annotation.id;
        option.textContent = `${annotation.type[0].toUpperCase()}${annotation.type.slice(1)} ${index + 1}`;
        annotationSelect.append(option);
      }
      if (!photo.annotations.some((annotation) => annotation.id === selectedId && annotation.type !== 'text')) selectedId = annotationSelect.options[0]?.value ?? '';
      annotationSelect.value = selectedId;
      annotationSelect.disabled = !selectedId;
      deleteSelected.disabled = !selectedId;
      refreshDimension();
    };
    const setDimension = (meters: number): boolean => {
      const annotation = selectedAnnotation();
      if (!annotation || annotation.type === 'text' || !Number.isFinite(meters) || meters < 0.001 || meters > 100000) {
        dimensionStatus.textContent = annotation ? 'Enter a dimension between 0.001 and 100000 meters.' : 'Select an arrow, rectangle, or circle first.';
        return false;
      }
      annotation[dimensionKey()] = meters;
      updateAnnotations();
      refreshDimension();
      return true;
    };
    const refreshPhotoBluetooth = () => {
      const panel = measurementSection.querySelector<HTMLElement>('[data-bluetooth-panel]');
      const annotation = selectedAnnotation();
      const target = annotation && annotation.type !== 'text' ? `${annotation.type} ${dimensionSelect.selectedOptions[0]?.textContent?.toLowerCase()}` : 'Select a measured annotation';
      const next = this.bluetoothPanel(project, room, undefined, undefined, {
        label: target,
        apply: (captureId) => {
          const capture = this.bluetoothCapture.list().find((candidate) => candidate.id === captureId);
          if (!capture || !setDimension(capture.valueMeters)) return;
          this.bluetoothCapture.discard(captureId);
          this.showToast('Dimension applied. Save the photo to keep it.');
          refreshPhotoBluetooth();
        },
      });
      if (panel) panel.replaceWith(next);
      else measurementSection.append(next);
    };
    annotationSelect.addEventListener('change', () => { selectedId = annotationSelect.value; updateAnnotations(); refreshDimension(); refreshPhotoBluetooth(); });
    dimensionSelect.addEventListener('change', () => { refreshDimension(); refreshPhotoBluetooth(); });
    let start: { x: number; y: number } | null = null;
    stage.addEventListener('pointerdown', (event) => {
      start = normalizedPoint(image, event.clientX, event.clientY);
      stage.setPointerCapture(event.pointerId);
    });
    stage.addEventListener('pointerup', (event) => {
      if (!start) return;
      const end = normalizedPoint(image, event.clientX, event.clientY);
      if (tool === 'text') {
        const text = textInput.value.trim();
        if (text) {
          const annotation = { id: createId(), type: 'text' as const, x: end.x, y: end.y, text, color: '#e85d3f' };
          photo.annotations.push(annotation);
          selectedId = annotation.id;
        }
      } else {
        const annotation: PhotoAnnotation = { id: createId(), type: tool, x: start.x, y: start.y, endX: end.x, endY: end.y, color: '#e85d3f' };
        photo.annotations.push(annotation);
        selectedId = annotation.id;
      }
      start = null;
      updateAnnotations();
      refreshSelection();
      refreshPhotoBluetooth();
    });
    const tools = element('div', 'annotation-tools');
    for (const annotationTool of ['arrow', 'rectangle', 'circle', 'text'] as const) {
      const toolButton = button(annotationTool[0].toUpperCase() + annotationTool.slice(1), `button quiet compact${tool === annotationTool ? ' is-active' : ''}`, () => {
        tool = annotationTool;
        tools.querySelectorAll<HTMLButtonElement>('[data-photo-tool]').forEach((item) => {
          const active = item.dataset.photoTool === tool;
          item.classList.toggle('is-active', active);
          item.setAttribute('aria-pressed', String(active));
        });
      });
      toolButton.dataset.photoTool = annotationTool;
      toolButton.setAttribute('aria-pressed', String(tool === annotationTool));
      tools.append(toolButton);
    }
    tools.append(button('Undo annotation', 'button quiet compact', () => { photo.annotations.pop(); refreshSelection(); updateAnnotations(); refreshPhotoBluetooth(); }));
    const deleteSelected = button('Delete selected annotation', 'button quiet compact', () => {
      photo.annotations = photo.annotations.filter((annotation) => annotation.id !== selectedId);
      selectedId = '';
      refreshSelection();
      updateAnnotations();
      refreshPhotoBluetooth();
    });
    deleteSelected.disabled = !selectedId;
    tools.append(deleteSelected);
    const annotationField = element('label', 'field');
    annotationField.append(element('span', 'field-label', 'Annotation'), annotationSelect);
    const dimensionField = element('label', 'field');
    dimensionField.append(element('span', 'field-label', 'Dimension'), dimensionSelect);
    const valueField = element('label', 'field');
    valueField.append(element('span', 'field-label', `Value (${project.preferredUnits === 'imperial' ? 'ft' : 'm'})`), dimensionInput);
    const manualAction = button('Set dimension', 'button quiet compact', () => {
      const factor = project.preferredUnits === 'imperial' ? 3.280839895 : 1;
      setDimension(parseDecimalInput(dimensionInput.value) / factor);
    });
    measurementSection.append(element('h3', '', 'Annotation dimensions'), annotationField, dimensionField, valueField, manualAction, dimensionStatus);
    refreshSelection();
    refreshPhotoBluetooth();
    this.photoMeasurement = { content, refresh: refreshPhotoBluetooth };
    const actions = element('div', 'dialog-actions');
    const closeEditor = () => {
      const changed = JSON.stringify(photo) !== JSON.stringify(originalPhoto)
        || titleField.value !== originalPhoto.title
        || notes.value !== originalPhoto.notes;
      if (!changed) {
        dialog.close();
        return;
      }
      const confirmation = element('div', 'dialog-content');
      confirmation.append(element('h2', 'dialog-title', 'Discard photo edits?'), element('p', '', 'Your annotation and text changes have not been saved.'));
      const choices = element('div', 'dialog-actions');
      choices.append(button('Keep editing', 'button quiet', () => {
        dialog.replaceChildren(content);
        this.openDialog(dialog);
      }));
      choices.append(button('Discard changes', 'button danger', () => {
        const index = room.photos.findIndex((candidate) => candidate.id === originalPhoto.id);
        if (index >= 0) room.photos[index] = originalPhoto;
        dialog.close();
        this.render();
      }));
      confirmation.append(choices);
      dialog.replaceChildren(confirmation);
      this.openDialog(dialog);
    };
    const cancelDialog = (event: Event) => {
      event.preventDefault();
      closeEditor();
    };
    dialog.addEventListener('cancel', cancelDialog);
    dialog.addEventListener('close', () => dialog.removeEventListener('cancel', cancelDialog), { once: true });
    actions.append(button('Close', 'button quiet', closeEditor));
    actions.append(button('Delete photo', 'button danger', () => {
      room.photos = room.photos.filter((candidate) => candidate.id !== photo.id);
      project.modifiedAt = new Date().toISOString();
      if (this.save(project)) { dialog.close(); this.render(); }
    }));
    actions.append(button('Save', 'button primary', () => {
      photo.title = titleField.value.trim() || 'Site photo';
      photo.notes = notes.value.trim();
      project.modifiedAt = new Date().toISOString();
      if (this.save(project)) { dialog.close(); this.render(); }
    }));
    content.append(stage, tools, textInput, measurementSection, titleField, notes, actions);
    dialog.replaceChildren(content);
    this.openDialog(dialog);
  }

  private renderUnavailableView(main: HTMLElement, title: string, message: string): void {
    const page = element('section', 'page unavailable-page');
    const content = element('div', 'empty-state');
    content.append(element('span', 'empty-rule'), element('h1', '', title), element('p', '', message));
    if (!this.selectedProject()) content.append(button('Browse projects', 'button primary', () => this.setView('projects')));
    page.append(content);
    main.append(page);
  }

  private showProjectDialog(existing?: Project): void {
    const dialog = this.dialog();
    const project = existing ?? createProject('Untitled project');
    const content = element('div', 'dialog-content');
    content.append(element('p', 'eyebrow', existing ? 'Project details' : 'New project'), element('h2', 'dialog-title', existing ? 'Edit project' : 'Create project'));
    const form = this.projectForm(project, 'dialog');
    const actions = element('div', 'dialog-actions');
    actions.append(button('Cancel', 'button quiet', () => dialog.close()));
    actions.append(button(existing ? 'Save changes' : 'Create project', 'button primary', () => {
      if (!form.reportValidity()) return;
      const formData = new FormData(form);
      project.name = formValue(formData, 'name').trim();
      project.projectNumber = formValue(formData, 'projectNumber').trim();
      project.customer = formValue(formData, 'customer').trim();
      project.address = formValue(formData, 'address').trim();
      project.description = formValue(formData, 'description').trim();
      if (!project.name) return;
      project.modifiedAt = new Date().toISOString();
      if (this.save(project)) {
        dialog.close();
        this.openProject(project.id);
      }
    }));
    content.append(form, actions);
    dialog.replaceChildren(content);
    this.openDialog(dialog);
  }

  private showManageDialog(projectId: string): void {
    const project = this.repository.get(projectId);
    if (!project) return;
    const dialog = this.dialog();
    const content = element('div', 'dialog-content');
    content.append(element('p', 'eyebrow', 'Manage project'), element('h2', 'dialog-title', project.name));
    const actions = element('div', 'manage-actions');
    actions.append(button('Rename and edit', 'button quiet stretch', () => this.showProjectDialog(project)));
    actions.append(button('Duplicate', 'button quiet stretch', () => {
      try {
        const copy = this.repository.duplicate(project.id);
        dialog.close();
        this.showToast(`Created ${copy.name}`);
        this.render();
      } catch (error) {
        this.reportPersistenceError(error);
      }
    }));
    actions.append(button(project.status === 'archived' ? 'Restore to active' : 'Archive', 'button quiet stretch', () => {
      project.status = project.status === 'archived' ? 'active' : 'archived';
      project.modifiedAt = new Date().toISOString();
      if (this.save(project)) {
        dialog.close();
        this.render();
      }
    }));
    actions.append(button('Export project', 'button quiet stretch', () => this.exportProject(project)));
    actions.append(button('Delete local copy', 'button danger stretch', () => this.confirmDelete(project)));
    actions.append(button('Cancel', 'button quiet stretch', () => dialog.close()));
    content.append(actions);
    dialog.replaceChildren(content);
    this.openDialog(dialog);
  }

  private showConfirmationDialog(title: string, message: string, onConfirm: () => void): void {
    const dialog = this.dialog();
    const content = element('div', 'dialog-content');
    content.append(element('h2', 'dialog-title', title), element('p', '', message));
    const actions = element('div', 'dialog-actions');
    actions.append(button('Cancel', 'button quiet', () => dialog.close()));
    actions.append(button('Replace', 'button danger', () => {
      dialog.close();
      onConfirm();
    }));
    content.append(actions);
    dialog.replaceChildren(content);
    this.openDialog(dialog);
  }

  private confirmDelete(project: Project): void {
    const dialog = this.dialog();
    const content = element('div', 'dialog-content');
    content.append(element('h2', 'dialog-title', 'Delete local copy?'), element('p', '', `${project.name} will be removed from this device. You can undo during this session.`));
    const actions = element('div', 'dialog-actions');
    actions.append(button('Cancel', 'button quiet', () => dialog.close()));
    actions.append(button('Delete', 'button danger', () => {
      try {
        this.repository.delete(project.id);
      } catch (error) {
        this.reportPersistenceError(error);
        return;
      }
      this.undoDeletion = { project, expiresAt: Date.now() + 30_000 };
      window.clearTimeout(this.undoTimer);
      this.undoTimer = window.setTimeout(() => {
        this.undoDeletion = null;
        this.root.querySelector('.toast-action')?.remove();
      }, 30_000);
      if (this.selectedProjectId === project.id) this.selectedProjectId = null;
      dialog.close();
      this.showToast('Project deleted', 'Undo', () => this.undoProjectDeletion());
      this.render();
    }));
    content.append(actions);
    dialog.replaceChildren(content);
    this.openDialog(dialog);
  }

  private async handleImport(file: File | undefined): Promise<void> {
    if (!file) return;
    try {
      const project = await readProjectFile(file);
      this.showImportPreview(project);
    } catch (error) {
      this.debugLog?.log('handled.error', error);
      this.showToast(error instanceof Error ? error.message : 'The project could not be imported.');
    } finally {
      const input = this.root.querySelector<HTMLInputElement>('[data-import-input]');
      if (input) input.value = '';
    }
  }

  private async handleBackupImport(file: File | undefined): Promise<void> {
    if (!file) return;
    try {
      this.showBackupPreview(await readBackupFile(file));
    } catch (error) {
      this.debugLog?.log('handled.error', error);
      this.showToast(error instanceof Error ? error.message : 'The backup could not be restored.');
    } finally {
      const input = this.root.querySelector<HTMLInputElement>('[data-backup-input]');
      if (input) input.value = '';
    }
  }

  private showBackupPreview(backup: BackupFile): void {
    const dialog = this.dialog();
    const currentProjects = this.repository.list().flatMap((summary) => {
      const project = this.repository.get(summary.id);
      return project ? [project] : [];
    });
    const content = element('div', 'dialog-content');
    content.append(element('p', 'eyebrow', 'Review full backup'), element('h2', 'dialog-title', 'Restore local projects'));
    const preview = element('dl', 'import-preview');
    appendDefinition(preview, 'Backup exported', formatDate(backup.exportedAt));
    appendDefinition(preview, 'Projects in backup', String(backup.projects.length));
    appendDefinition(preview, 'Projects on this device', String(currentProjects.length));
    content.append(preview);
    const names = element('ul', 'backup-project-list');
    backup.projects.forEach((project) => names.append(element('li', '', `${project.name} · ${totalRooms(project)} rooms · modified ${formatDate(project.modifiedAt)}`)));
    content.append(names);
    content.append(element('p', 'storage-warning', currentProjects.length
      ? 'This replaces every local project. An export of your current projects will be requested first.'
      : 'This replaces the local project list on this device.'));
    const actions = element('div', 'dialog-actions stacked');
    actions.append(button(currentProjects.length ? 'Download current backup & replace' : 'Restore projects', 'button danger stretch', () => {
      const restore = () => {
        if (!dialog.open) return;
        try {
          this.repository.replaceAll(backup.projects);
          this.undoDeletion = null;
          window.clearTimeout(this.undoTimer);
          this.undoTimer = undefined;
          this.selectedProjectId = null;
          this.activeRoomId = null;
          this.dirty = false;
          this.saveState = 'saved';
          this.saveTime = new Date().toISOString();
          dialog.close();
          this.setView('projects');
          this.showToast('Backup restored');
        } catch (error) {
          this.reportPersistenceError(error);
        }
      };
      try {
        if (currentProjects.length) this.downloadText(serializeBackup(currentProjects), `sitemeasure-before-restore-${new Date().toISOString().slice(0, 10)}.sitemeasure-backup.json`, 'application/json', restore);
        else restore();
      } catch (error) { this.reportPersistenceError(error); }
    }));
    actions.append(button('Cancel', 'button quiet stretch', () => dialog.close()));
    content.append(actions);
    dialog.replaceChildren(content);
    this.openDialog(dialog);
  }

  private openBackupPicker(): void {
    this.root.querySelector<HTMLInputElement>('[data-backup-input]')?.click();
  }

  private showImportPreview(project: Project): void {
    const dialog = this.dialog();
    const existing = this.repository.get(project.id);
    const content = element('div', 'dialog-content');
    content.append(element('p', 'eyebrow', 'Review import'), element('h2', 'dialog-title', project.name));
    const preview = element('dl', 'import-preview');
    appendDefinition(preview, 'Project number', project.projectNumber || 'Not set');
    appendDefinition(preview, 'Customer', project.customer || 'Not set');
    appendDefinition(preview, 'Address', project.address || 'Not set');
    appendDefinition(preview, 'Modified', formatDate(project.modifiedAt));
    appendDefinition(preview, 'Buildings', String(project.buildings.length));
    appendDefinition(preview, 'Floors', String(totalFloors(project)));
    appendDefinition(preview, 'Rooms', String(totalRooms(project)));
    appendDefinition(preview, 'Photos', String(totalPhotos(project)));
    appendDefinition(preview, 'Local project affected', existing ? `${existing.name} · modified ${formatDate(existing.modifiedAt)}` : 'None');
    content.append(preview);
    content.append(element('p', existing ? 'storage-warning' : 'field-hint', existing
      ? 'Replace overwrites the local project shown above. Import as copy keeps both projects.'
      : 'Import adds this project to this device. Import as copy creates a separate copy.'));
    const actions = element('div', 'dialog-actions stacked');
    if (existing) {
      actions.append(button(`Replace local copy: ${existing.name}`, 'button danger stretch', () => {
        if (this.save(project)) {
          dialog.close();
          this.openProject(project.id);
        }
      }));
    }
    actions.append(button('Import as copy (keep both)', 'button primary stretch', () => {
      const copy = copyImportedProject(project);
      if (this.save(copy)) {
        dialog.close();
        this.openProject(copy.id);
      }
    }));
    actions.append(button('Cancel', 'button quiet stretch', () => dialog.close()));
    if (!existing) {
      actions.prepend(button('Import project', 'button primary stretch', () => {
        if (this.save(project)) {
          dialog.close();
          this.openProject(project.id);
        }
      }));
    }
    content.append(actions);
    dialog.replaceChildren(content);
    this.openDialog(dialog);
  }

  private openImportPicker(): void {
    this.root.querySelector<HTMLInputElement>('[data-import-input]')?.click();
  }

  private async showRoomViewer(project: Project, room: Room): Promise<void> {
    const dialog = this.dialog();
    const loading = element('div', 'dialog-content room-visualization-loading');
    loading.append(element('p', 'eyebrow', '3D room'), element('h2', 'dialog-title', `Creating ${room.name}`));
    dialog.replaceChildren(loading);
    this.openDialog(dialog);

    try {
      const [{ createRoomPreview }, { roomViewerHtml }] = await Promise.all([
        import('./reports/room-visualization'),
        import('./reports/room-viewer-export'),
      ]);
      if (!dialog.open || !loading.isConnected) return;
      const content = element('div', 'dialog-content room-visualization-dialog');
      content.append(element('p', 'eyebrow', project.name), element('h2', 'dialog-title', `${room.name} in 3D`));
      const stage = element('div', 'room-visualization-stage');
      const actions = element('div', 'dialog-actions room-visualization-actions');
      let currentRoom = room;
      let preview: ReturnType<typeof createRoomPreview> | null = null;
      const reload = () => {
        const editorRoom = this.activeEditor?.getRoom();
        const savedRoom = this.repository.get(project.id)?.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.rooms)).find((candidate) => candidate.id === room.id);
        currentRoom = editorRoom?.id === room.id ? editorRoom : savedRoom ?? currentRoom;
        preview?.dispose();
        preview = null;
        stage.replaceChildren();
        try {
          preview = createRoomPreview(stage, currentRoom);
        } catch (error) {
          this.debugLog?.log('handled.error', error);
          stage.append(element('p', 'validation-warning', error instanceof Error ? error.message : 'The 3D room could not be displayed.'));
        }
      };
      actions.append(button('Close', 'button quiet', () => dialog.close()));
      actions.append(button('Reload 3D view', 'button quiet', reload));
      actions.append(button('Download 3D view', 'button primary', () => {
        this.downloadText(roomViewerHtml(project.name, currentRoom), `${safeFilename(currentRoom.name)}-3d-view.html`, 'text/html');
      }));
      content.append(stage, actions);
      dialog.replaceChildren(content);
      reload();
      dialog.addEventListener('close', () => preview?.dispose(), { once: true });
    } catch (error) {
      this.debugLog?.log('handled.error', error);
      const content = element('div', 'dialog-content');
      content.append(element('p', 'eyebrow', '3D room'), element('h2', 'dialog-title', 'Could not render room'));
      content.append(element('p', 'validation-warning', error instanceof Error ? error.message : 'The 3D room could not be displayed.'));
      content.append(element('div', 'dialog-actions', ''));
      content.lastElementChild?.append(button('Close', 'button primary', () => dialog.close()));
      dialog.replaceChildren(content);
    }
  }

  private exportProject(project: Project, includePhotos = true): void {
    let stage = 'starting';
    let failureStage: string | undefined;
    const report = (step: string, detail: Record<string, unknown> = {}) => {
      if (step === 'download-step-failed') failureStage = stage;
      stage = step;
      this.debugLog?.log('project-export', { step, ...detail });
    };
    try {
      const rooms = project.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.rooms));
      report('starting', {
        includePhotos, rooms: rooms.length, photos: rooms.reduce((count, room) => count + room.photos.length, 0),
        userAgent: navigator.userAgent, platform: navigator.platform, protocol: window.location.protocol,
        userActivation: navigator.userActivation?.isActive ?? null,
        createObjectURL: typeof URL.createObjectURL === 'function', revokeObjectURL: typeof URL.revokeObjectURL === 'function',
        share: typeof navigator.share === 'function',
      });
      const exported = includePhotos ? project : structuredClone(project);
      if (!includePhotos) exported.buildings.forEach((building) => building.floors.forEach((floor) => floor.rooms.forEach((room) => { room.photos = []; })));
      report('serializing');
      const serialized = serializeProject(exported);
      report('serialized', { characters: serialized.length });
      const blob = new Blob([serialized], { type: 'application/json' });
      const filename = projectFilename(exported);
      report('blob-created', { bytes: blob.size, mimeType: blob.type, filename });
      this.exportBlob(blob, filename, 'Project', report, (error, sharing) => {
        this.debugLog?.log('project-export.failed', { stage: sharing ? 'sharing-file' : failureStage ?? stage, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
        this.debugLog?.log('project-export.error', error);
      });
    } catch (error) {
      this.debugLog?.log('project-export.failed', { stage: failureStage ?? stage, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
      this.debugLog?.log('project-export.error', error);
      this.showToast('Project export failed. Check the debug log for details.');
    }
  }

  private async exportRoomPng(project: Project, room: Room): Promise<void> {
    try {
      const blob = await svgToPng(floorPlanSvg(project, room));
      const filename = `${safeFilename(room.name)}-plan.png`;
      if (/\bBluefy\//i.test(navigator.userAgent)) this.showToast('PNG ready.', 'Export PNG', () => this.exportBlob(blob, filename));
      else this.exportBlob(blob, filename);
    } catch (error) {
      this.debugLog?.log('handled.error', error);
      this.showToast(error instanceof Error ? error.message : 'The PNG could not be exported.');
    }
  }

  private printReport(project: Project): void {
    const reportUrl = URL.createObjectURL(new Blob([printableReport(project)], { type: 'text/html;charset=utf-8' }));
    const printWindow = window.open(reportUrl, '_blank');
    if (!printWindow) {
      URL.revokeObjectURL(reportUrl);
      this.showToast('Allow pop-ups to open the printable report.');
      return;
    }
    printWindow.opener = null;
    printWindow.addEventListener('load', () => {
      printWindow.print();
      URL.revokeObjectURL(reportUrl);
    }, { once: true });
  }

  private downloadText(text: string, filename: string, mimeType: string, onComplete?: () => void): void {
    this.exportBlob(new Blob([text], { type: `${mimeType};charset=utf-8` }), filename, 'File', undefined, undefined, onComplete);
  }

  private exportBlob(blob: Blob, filename: string, label = 'File', report?: (step: string, detail?: Record<string, unknown>) => void, onError?: (error: unknown, sharing: boolean) => void, onComplete?: () => void): void {
    this.root.querySelector('.export-share-fallback')?.remove();
    const fail = (error: unknown, sharing: boolean) => {
      if (onError) onError(error, sharing);
      else this.debugLog?.log('file-export.error', error);
    };
    const download = () => {
      try {
        this.downloadBlob(blob, filename, report);
        report?.('download-requested', { browserConfirmationAvailable: false });
        this.showToast(`${label} download requested. Check your browser downloads.`);
        onComplete?.();
      } catch (error) {
        fail(error, false);
        this.showToast(`${label} export failed. Check the debug log for details.`);
      }
    };
    if (/\bBluefy\//i.test(navigator.userAgent) && typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && typeof File === 'function') {
      let shareData: ShareData;
      try {
        shareData = { files: [new File([blob], filename, { type: blob.type })] };
      } catch (error) {
        fail(error, false);
        this.showToast(`${label} export failed. Check the debug log for details.`);
        return;
      }
      let canShare = false;
      try {
        canShare = navigator.canShare(shareData);
        report?.('file-share-capability', { canShare });
      } catch (error) {
        report?.('file-share-capability-failed', { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
      }
      if (canShare) {
        const shareFailed = (error: unknown) => {
          if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') {
            report?.('share-cancelled');
            this.showToast(`${label} sharing cancelled.`);
            return;
          }
          fail(error, true);
          const message = `Could not share the ${label.toLowerCase()}.`;
          const dialogContent = this.root.querySelector<HTMLElement>('.app-dialog[open] .dialog-content');
          if (dialogContent) {
            const fallback = element('div', 'export-share-fallback');
            fallback.append(element('p', 'validation-warning', message), button('Download instead', 'button quiet', () => { fallback.remove(); download(); }));
            dialogContent.append(fallback);
          } else this.showToast(message, 'Download instead', download);
        };
        report?.('sharing-file', { userActivation: navigator.userActivation?.isActive ?? null });
        try {
          void navigator.share(shareData).then(() => {
            report?.('share-completed', { fileSaveConfirmationAvailable: false });
            this.showToast(`${label} share completed.`);
            onComplete?.();
          }, shareFailed);
        } catch (error) {
          shareFailed(error);
        }
        return;
      }
    }
    download();
  }

  private downloadBlob(blob: Blob, filename: string, report?: (step: string, detail?: Record<string, unknown>) => void): void {
    report?.('creating-object-url');
    const url = URL.createObjectURL(blob);
    let link: HTMLAnchorElement | undefined;
    let requested = false;
    try {
      report?.('object-url-created', { scheme: url.split(':', 1)[0] });
      link = document.createElement('a');
      report?.('link-created', { downloadAttributeSupported: 'download' in link });
      link.href = url;
      link.download = filename;
      link.hidden = true;
      document.body.append(link);
      report?.('clicking-link', { userActivation: navigator.userActivation?.isActive ?? null, attachedToDocument: link.isConnected });
      link.click();
      requested = true;
      report?.('link-click-returned');
    } catch (error) {
      report?.('download-step-failed', { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
      throw error;
    } finally {
      link?.remove();
      if (requested) {
        report?.('object-url-revocation-scheduled', { delayMs: 60000 });
        window.setTimeout(() => {
          try {
            URL.revokeObjectURL(url);
            report?.('object-url-revoked');
          } catch (error) {
            this.debugLog?.log('project-export.cleanup-error', error);
          }
        }, 60000);
      } else {
        report?.('revoking-object-url');
        URL.revokeObjectURL(url);
        report?.('object-url-revoked');
      }
    }
  }

  private openProject(projectId: string): void {
    this.selectedProjectId = projectId;
    this.setView('plan');
  }

  private selectedProject(): Project | null {
    return this.selectedProjectId ? this.repository.get(this.selectedProjectId) : null;
  }

  private setView(view: PrimaryView): void {
    const fromMiscToFeature = this.view === 'misc' && (view === 'scan' || view === 'speedometer' || view === 'target-practice');
    this.disposeFeature(view);
    const hash = view === 'projects' ? '' : `#${view}`;
    if (window.location.hash !== hash) {
      const url = window.location.pathname + window.location.search + hash;
      if (fromMiscToFeature) history.pushState(null, '', url);
      else history.replaceState(null, '', url);
    }
    this.view = view;
    this.render();
  }

  private disposeFeature(next: PrimaryView): void {
    if (this.view === 'scan' && next !== 'scan') this.scanPage.dispose();
    if (this.view === 'speedometer' && next !== 'speedometer') this.speedometerPage.dispose();
    if (this.view === 'target-practice' && next !== 'target-practice') this.targetPracticePage.dispose();
  }

  private scheduleSave(project: Project): void {
    this.dirty = true;
    this.saveState = 'saving';
    this.renderSaveIndicator();
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(project), 650);
  }

  private save(project: Project): boolean {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    try {
      this.repository.save(project);
      this.dirty = false;
      this.saveState = 'saved';
      this.saveTime = new Date().toISOString();
      this.renderSaveIndicator();
      return true;
    } catch (error) {
      this.dirty = true;
      this.saveState = 'error';
      this.renderSaveIndicator();
      this.reportPersistenceError(error);
      return false;
    }
  }

  private reportPersistenceError(error: unknown): void {
    this.debugLog?.log('handled.error', error);
    this.notice = error instanceof Error ? error.message : 'The project could not be saved.';
    this.renderNotice();
    this.showToast(this.notice);
  }

  private renderSaveIndicator(): void {
    const indicator = this.root.querySelector<HTMLElement>('.save-indicator');
    if (!indicator) return;
    const savedAt = this.saveTime ? ` at ${formatTime(this.saveTime)}` : '';
    const labels: Record<SaveState, string> = {
      idle: 'On this device',
      saving: 'Saving locally…',
      saved: `Saved locally${savedAt}`,
      error: 'Not saved',
    };
    indicator.textContent = labels[this.saveState];
    indicator.classList.toggle('has-error', this.saveState === 'error');
  }

  private renderNotice(): void {
    const notice = this.root.querySelector<HTMLElement>('.notice');
    if (!notice) return;
    notice.textContent = this.notice;
    notice.hidden = !this.notice;
  }

  private showToast(message: string, actionLabel?: string, action?: () => void): void {
    const toast = this.root.querySelector<HTMLElement>('.toast');
    if (!toast) return;
    window.clearTimeout(this.toastHideTimer);
    toast.replaceChildren(element('span', '', message));
    if (actionLabel && action) toast.append(button(actionLabel, 'toast-action', action));
    if (this.undoDeletion && actionLabel !== 'Undo') {
      toast.append(button('Undo', 'toast-action', () => this.undoProjectDeletion()));
    }
    toast.hidden = false;
    this.toastHideTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, action ? 30_000 : 4_000);
  }

  private undoProjectDeletion(): void {
    const deletion = this.undoDeletion;
    if (!deletion || deletion.expiresAt < Date.now()) return;
    try {
      this.repository.save(deletion.project);
      this.undoDeletion = null;
      window.clearTimeout(this.undoTimer);
      this.undoTimer = undefined;
      this.render();
    } catch (error) {
      this.reportPersistenceError(error);
    }
  }

  private dialog(): HTMLDialogElement {
    const dialog = this.root.querySelector<HTMLDialogElement>('.app-dialog');
    if (!dialog) throw new Error('Application dialog is unavailable.');
    return dialog;
  }

  private openDialog(dialog: HTMLDialogElement): void {
    const title = dialog.querySelector<HTMLElement>('.dialog-title');
    if (title) {
      title.id = 'dialog-title';
      dialog.setAttribute('aria-labelledby', title.id);
    }
    if (!dialog.open) dialog.showModal();
    window.requestAnimationFrame(() => dialog.querySelector<HTMLInputElement>('input')?.focus());
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text) result.textContent = text;
  return result;
}

function button(label: string, className: string, action: () => void): HTMLButtonElement {
  const result = document.createElement('button');
  result.type = 'button';
  result.className = className;
  result.textContent = label;
  result.addEventListener('click', action);
  return result;
}

function metric(value: string, label: string): HTMLElement {
  const result = element('span', 'metric');
  result.append(element('strong', '', value), element('small', '', label));
  return result;
}

function calculation(value: string, label: string): HTMLElement {
  const result = element('div', 'calculation');
  result.append(element('strong', '', value), element('small', '', label));
  return result;
}

function parseDecimalInput(value: string): number {
  return Number(value.trim().replace(',', '.'));
}

function appendDefinition(list: HTMLDListElement, label: string, value: string): void {
  list.append(element('dt', '', label), element('dd', '', value));
}

function totalRooms(project: Project): number {
  return project.buildings.reduce((buildingTotal, building) => buildingTotal + building.floors.reduce((floorTotal, floor) => floorTotal + floor.rooms.length, 0), 0);
}

function totalFloors(project: Project): number {
  return project.buildings.reduce((total, building) => total + building.floors.length, 0);
}

function totalPhotos(project: Project): number {
  return project.buildings.reduce((buildingTotal, building) => buildingTotal + building.floors.reduce((floorTotal, floor) => floorTotal + floor.rooms.reduce((roomTotal, room) => roomTotal + room.photos.length, 0), 0), 0);
}

function measurementTargetLabel(room: Room, measurement: Room['measurements'][number]): string {
  if (measurement.targetType === 'room') return 'Room measurement';
  if (measurement.targetType === 'wall') {
    const index = room.walls.findIndex((wall) => wall.id === measurement.targetId);
    return index >= 0 ? `Wall ${index + 1}` : 'Wall (not found)';
  }
  const object = room.objects.find((candidate) => candidate.id === measurement.targetId);
  if (object) return object.name;
  if (room.doors.some((opening) => opening.id === measurement.targetId)) return 'Door';
  if (room.windows.some((opening) => opening.id === measurement.targetId)) return 'Window';
  return 'Other target';
}

function formValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

function navSymbol(view: PrimaryView): string {
  return { projects: 'P', plan: '⌜', objects: '▣', measure: '↕', photos: '□', more: '…', misc: 'M', ble: 'B', scan: 'S', speedometer: 'S', 'target-practice': 'T' }[view];
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value));
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

function safeFilename(value: string): string {
  return value.normalize('NFKD').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'project';
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unitIndex).toFixed(unitIndex ? 1 : 0)} ${units[unitIndex]}`;
}
