import { copyImportedProject, projectFilename, readProjectFile, serializeProject } from './data/project-files';
import { LocalStorageProjectRepository, type RepositoryWarning } from './data/local-storage-repository';
import { createId, createProject, createRoom, type PhotoAnnotation, type Project, type ProjectPhoto, type ProjectSummary, type Room } from './domain/models';
import { FloorPlanEditor, type EditorSelection } from './editor/floor-plan-editor';
import { distanceBetween, formatLength, openingArea, polygonIssues, roomArea, roomVolume, wallArea } from './geometry';
import { BoschLaserMeasureAdapter } from './bluetooth/bosch-laser-measure-adapter';
import { FakeLaserMeasureAdapter } from './bluetooth/fake-laser-measure-adapter';
import { MeasurementCapture } from './bluetooth/measurement-capture';
import { selectBluetoothProvider } from './bluetooth/providers/select-bluetooth-provider';
import type { BluetoothConnectionState, LaserMeasureAdapter } from './bluetooth/types';
import { normalizedPoint, renderPhotoAnnotations } from './photos/photo-annotations';
import { processPhoto } from './photos/photo-processing';
import { floorPlanSvg, measurementsCsv, printableReport, svgToPng } from './reports/project-exports';

type PrimaryView = 'projects' | 'plan' | 'measure' | 'photos' | 'more';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface UndoDeletion {
  project: Project;
  expiresAt: number;
}

const navItems: Array<{ id: PrimaryView; label: string }> = [
  { id: 'projects', label: 'Projects' },
  { id: 'plan', label: 'Plan' },
  { id: 'measure', label: 'Measure' },
  { id: 'photos', label: 'Photos' },
  { id: 'more', label: 'More' },
];

export class SiteMeasureApp {
  private readonly root: HTMLElement;
  private readonly repository: LocalStorageProjectRepository;
  private readonly bluetoothProvider = selectBluetoothProvider();
  private readonly bluetoothCapture = new MeasurementCapture();
  private bluetoothAdapter: LaserMeasureAdapter | null = null;
  private bluetoothState: BluetoothConnectionState = 'ready';
  private bluetoothDetail = '';
  private measurementPanelContext: { project: Project; room: Room; wall: Project['buildings'][number]['floors'][number]['rooms'][number]['walls'][number] } | null = null;
  private view: PrimaryView = 'projects';
  private selectedProjectId: string | null = null;
  private dirty = false;
  private saveState: SaveState = 'idle';
  private saveTime: string | null = null;
  private saveTimer: number | undefined;
  private undoDeletion: UndoDeletion | null = null;
  private searchTerm = '';
  private showArchived = false;
  private notice = '';
  private activeRoomId: string | null = null;
  private activeEditor: FloorPlanEditor | null = null;
  private editorSelection: EditorSelection = null;

  constructor(root: HTMLElement, repositoryWarning?: RepositoryWarning) {
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
      if (this.dirty && this.saveState === 'error') {
        event.preventDefault();
      }
    });
    this.renderShell();
    this.render();
  }

  private renderShell(): void {
    this.root.innerHTML = `
      <div class="app-frame">
        <header class="app-header">
          <button class="brand-button" type="button" data-view="projects" aria-label="SiteMeasure projects">
            <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
            <span>SiteMeasure</span>
          </button>
          <div class="save-indicator" role="status" aria-live="polite"></div>
        </header>
        <div class="notice" role="status" aria-live="polite" hidden></div>
        <nav class="bottom-nav" aria-label="Primary navigation"></nav>
        <main class="app-main"></main>
      </div>
      <dialog class="app-dialog" aria-labelledby="dialog-title"></dialog>
      <input class="visually-hidden" type="file" accept=".sitemeasure.json,application/json" data-import-input />
      <input class="visually-hidden" type="file" accept="image/*" data-photo-library />
      <input class="visually-hidden" type="file" accept="image/*" capture="environment" data-photo-camera />
      <div class="toast" role="status" aria-live="polite" hidden></div>
    `;

    this.root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
      button.addEventListener('click', () => this.setView(button.dataset.view as PrimaryView));
    });
    this.root.querySelector<HTMLInputElement>('[data-import-input]')?.addEventListener('change', (event) => {
      void this.handleImport((event.currentTarget as HTMLInputElement).files?.[0]);
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
      const button = document.createElement('button');
      button.type = 'button';
      button.className = item.id === this.view ? 'nav-item is-active' : 'nav-item';
      button.setAttribute('aria-current', item.id === this.view ? 'page' : 'false');
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
      case 'measure':
        this.renderMeasurements(main);
        break;
      case 'photos':
        this.renderPhotos(main);
        break;
      case 'more':
        this.renderMore(main);
        break;
    }
    this.renderSaveIndicator();
    this.renderNotice();
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
    topActions.append(button('Room', 'button quiet compact', () => this.addRoom(project)));
    topActions.append(button('Floor', 'button quiet compact', () => this.addFloor(project)));
    topActions.append(button('Export', 'button quiet compact', () => this.exportProject(project)));
    top.append(identity, topActions);

    const canvas = element('div', 'plan-canvas');
    const hierarchy = element('div', 'plan-hierarchy');
    hierarchy.append(this.roomSelector(project), button('Rename', 'button quiet compact', () => this.renameRoom(project, active)));
    this.activeEditor = new FloorPlanEditor({
      room: active,
      units: project.preferredUnits,
      onChange: (room, completed) => this.updateRoom(project, room, completed),
      onSelection: (selection) => this.updateInspector(selection),
      onMeasure: (wall) => this.showMeasurementDialog(project, active, wall),
    });
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
    inspector.append(element('h2', '', this.editorSelection?.type === 'wall' ? 'Wall properties' : 'Room overview'));
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
        wallActions.append(button(wall.locked ? 'Unlock' : 'Lock', 'button quiet', () => this.activeEditor?.toggleLockSelection()));
        wallActions.append(button('Delete', 'button danger', () => this.activeEditor?.deleteSelection()));
        inspector.append(length, editLength, wallActions);
      }
    } else {
      const issues = polygonIssues(room.points).filter(() => room.points.length > 0);
      const metrics = element('div', 'room-calculations');
      metrics.append(calculation(`${roomArea(room).toFixed(2)} m²`, 'Area'));
      metrics.append(calculation(`${roomVolume(room).toFixed(2)} m³`, 'Volume at 2.7 m'));
      metrics.append(calculation(`${wallArea(room.walls, 2.7, openingArea(room.walls, room)).toFixed(2)} m²`, 'Net wall area'));
      inspector.append(metrics);
      if (issues.length) inspector.append(element('p', 'validation-warning', issues.join(' ')));
      inspector.append(element('p', 'inspector-help', 'Choose Wall or Room, then tap or drag on the plan. Use two fingers to pan and pinch to zoom.'));
      inspector.append(this.projectForm(project, 'autosave'));
    }
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
      this.activeEditor?.setWallLength(meters);
      const currentRoom = this.activeRoom(project);
      currentRoom?.measurements.push({ id: createId(), targetType: 'wall', targetId: wall.id, valueMeters: meters, capturedAt: new Date().toISOString(), source: 'manual' });
      project.modifiedAt = new Date().toISOString();
      if (this.save(project)) dialog.close();
    }));
    input.addEventListener('input', () => input.setCustomValidity(''));
    this.measurementPanelContext = { project, room, wall };
    content.append(target, field, this.bluetoothPanel(project, room, wall), actions);
    dialog.replaceChildren(content);
    this.openDialog(dialog);
  }

  private bluetoothPanel(project: Project, room: Room, wall?: Project['buildings'][number]['floors'][number]['rooms'][number]['walls'][number]): HTMLElement {
    const panel = element('section', 'bluetooth-panel');
    panel.dataset.bluetoothPanel = 'true';
    panel.append(element('h3', '', 'Laser measure'));
    const target = wall ? 'Selected wall' : 'Active room';
    panel.append(element('p', 'bluetooth-target', `Target: ${room.name} · ${target}`));
    const stateRow = element('div', 'bluetooth-status');
    stateRow.append(element('span', 'bluetooth-state', this.bluetoothStateLabel()), element('span', 'bluetooth-device', this.bluetoothAdapter?.deviceName || this.bluetoothProvider.label));
    panel.append(stateRow);
    if (this.bluetoothDetail) panel.append(element('p', 'bluetooth-detail', this.bluetoothDetail));
    if (this.bluetoothState === 'extension-required' || this.bluetoothProvider.id === 'unsupported') {
      panel.append(element('p', 'bluetooth-help', 'On iPhone and iPad Safari, enable iOSWebBLE. Manual measurements always remain available.'));
    }

    const captureMode = document.createElement('label');
    captureMode.className = 'capture-mode';
    const rapid = document.createElement('input');
    rapid.type = 'checkbox';
    rapid.checked = this.bluetoothCapture.mode === 'rapid';
    rapid.addEventListener('change', () => {
      this.bluetoothCapture.mode = rapid.checked ? 'rapid' : 'confirmation';
      this.refreshBluetoothSurfaces();
    });
    captureMode.append(rapid, element('span', '', 'Rapid capture'));
    panel.append(captureMode);

    const connectionActions = element('div', 'bluetooth-actions');
    connectionActions.append(button('Connect laser measure', 'button primary stretch', () => { void this.connectLaserMeasure(false); }));
    connectionActions.append(button('Try simulated device', 'button quiet stretch', () => { void this.connectLaserMeasure(true); }));
    if (this.bluetoothAdapter) {
      connectionActions.append(button('Disconnect', 'button quiet stretch', () => { void this.disconnectLaserMeasure(); }));
    }
    if (this.bluetoothAdapter instanceof FakeLaserMeasureAdapter && this.bluetoothState === 'connected') {
      connectionActions.append(button('Receive simulated value', 'button quiet stretch', () => this.bluetoothAdapter instanceof FakeLaserMeasureAdapter && this.bluetoothAdapter.emitDemoMeasurement()));
    }
    panel.append(connectionActions);

    const captures = this.bluetoothCapture.list();
    if (captures.length) {
      const queue = element('div', 'capture-queue');
      for (const capture of captures) {
        const row = element('article', 'capture-row');
        const readout = element('div', 'capture-readout');
        readout.append(element('strong', '', formatLength(capture.valueMeters, project.preferredUnits)));
        readout.append(element('span', '', `${capture.simulated ? 'SIMULATED · ' : ''}#${capture.sequence} · ${capture.deviceName}`));
        readout.append(element('time', '', formatTime(capture.capturedAt)));
        const actions = element('div', 'capture-row-actions');
        actions.append(button('Apply', 'button primary compact', () => this.applyBluetoothCapture(project, room, wall, capture.id)));
        actions.append(button('Retry', 'button quiet compact', () => {
          this.bluetoothCapture.discard(capture.id);
          if (this.bluetoothAdapter instanceof FakeLaserMeasureAdapter) this.bluetoothAdapter.emitDemoMeasurement();
          else void this.connectLaserMeasure(false);
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

  private async connectLaserMeasure(simulated: boolean): Promise<void> {
    await this.disconnectLaserMeasure(false);
    const adapter: LaserMeasureAdapter = simulated
      ? new FakeLaserMeasureAdapter()
      : new BoschLaserMeasureAdapter(this.bluetoothProvider);
    this.bluetoothAdapter = adapter;
    try {
      await adapter.connect(
        (measurement) => {
          this.bluetoothCapture.receive(measurement);
          this.showToast(measurement.simulated ? 'Simulated measurement received' : 'Measurement received');
          this.refreshBluetoothSurfaces();
        },
        (state, detail) => {
          this.bluetoothState = state;
          this.bluetoothDetail = detail ?? '';
          this.refreshBluetoothSurfaces();
        },
      );
    } catch {
      this.bluetoothAdapter = adapter;
      this.refreshBluetoothSurfaces();
    }
  }

  private async disconnectLaserMeasure(refresh = true): Promise<void> {
    await this.bluetoothAdapter?.disconnect();
    this.bluetoothAdapter = null;
    if (this.bluetoothProvider.id !== 'unsupported') this.bluetoothState = 'ready';
    else this.bluetoothState = this.bluetoothProvider.label === 'iOSWebBLE required' ? 'extension-required' : 'not-available';
    this.bluetoothDetail = '';
    if (refresh) this.refreshBluetoothSurfaces();
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
    if (this.measurementPanelContext && this.dialog().open) {
      const { project, room, wall } = this.measurementPanelContext;
      this.showMeasurementDialog(project, room, wall);
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
      this.showToast(measurement.simulated ? 'Simulated measurement applied' : 'Measurement applied');
      this.render();
    }
  }

  private addRoom(project: Project): void {
    const floor = project.buildings[0]?.floors[0];
    if (!floor) return;
    const room = createRoom(`Room ${floor.rooms.length + 1}`);
    floor.rooms.push(room);
    this.activeRoomId = room.id;
    project.modifiedAt = new Date().toISOString();
    if (this.save(project)) this.render();
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
    const measurements = project.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.rooms.flatMap((room) => room.measurements.map((measurement) => ({ measurement, room })))))
      .sort((left, right) => right.measurement.capturedAt.localeCompare(left.measurement.capturedAt));
    const list = element('div', 'measurement-list');
    if (!measurements.length) {
      list.append(element('p', 'measurements-empty', 'No measurements yet. Select a wall in Plan and choose Measure.'));
    }
    for (const { measurement, room } of measurements) {
      const row = element('article', 'measurement-row');
      row.append(element('strong', 'measurement-value', formatLength(measurement.valueMeters, project.preferredUnits)));
      row.append(element('span', '', `${room.name} · ${measurement.simulated ? 'simulated · ' : ''}${measurement.source} · ${formatDate(measurement.capturedAt)}`));
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
    const actions = element('section', 'settings-section');
    actions.append(element('h2', '', 'Project files and reports'));
    actions.append(button('Import project', 'button primary stretch', () => this.openImportPicker()));
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
    page.append(storage, actions);
    main.append(page);
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
    const updateAnnotations = () => {
      const rendered = renderPhotoAnnotations(image, photo.annotations);
      const current = stage.querySelector('svg');
      if (current) current.replaceWith(rendered);
      else stage.append(rendered);
    };
    image.addEventListener('load', () => {
      stage.append(renderPhotoAnnotations(image, photo.annotations));
    });
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
        if (text) photo.annotations.push({ id: createId(), type: 'text', x: end.x, y: end.y, text, color: '#e85d3f' });
      } else {
        photo.annotations.push({ id: createId(), type: tool, x: start.x, y: start.y, endX: end.x, endY: end.y, color: '#e85d3f' });
      }
      start = null;
      updateAnnotations();
    });
    const tools = element('div', 'annotation-tools');
    for (const annotationTool of ['arrow', 'rectangle', 'circle', 'text'] as const) {
      tools.append(button(annotationTool[0].toUpperCase() + annotationTool.slice(1), 'button quiet compact', () => {
        tool = annotationTool;
        tools.querySelectorAll('button').forEach((item) => item.classList.toggle('is-active', item.textContent?.toLowerCase() === tool));
      }));
    }
    tools.append(button('Undo annotation', 'button quiet compact', () => { photo.annotations.pop(); updateAnnotations(); }));
    const actions = element('div', 'dialog-actions');
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
    content.append(stage, tools, textInput, titleField, notes, actions);
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
      const copy = this.repository.duplicate(project.id);
      dialog.close();
      this.showToast(`Created ${copy.name}`);
      this.render();
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

  private confirmDelete(project: Project): void {
    const dialog = this.dialog();
    const content = element('div', 'dialog-content');
    content.append(element('h2', 'dialog-title', 'Delete local copy?'), element('p', '', `${project.name} will be removed from this device. You can undo during this session.`));
    const actions = element('div', 'dialog-actions');
    actions.append(button('Cancel', 'button quiet', () => dialog.close()));
    actions.append(button('Delete', 'button danger', () => {
      this.repository.delete(project.id);
      this.undoDeletion = { project, expiresAt: Date.now() + 30_000 };
      if (this.selectedProjectId === project.id) this.selectedProjectId = null;
      dialog.close();
      this.showToast('Project deleted', 'Undo', () => {
        if (!this.undoDeletion || this.undoDeletion.expiresAt < Date.now()) return;
        this.repository.save(this.undoDeletion.project);
        this.undoDeletion = null;
        this.render();
      });
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
      this.showToast(error instanceof Error ? error.message : 'The project could not be imported.');
    } finally {
      const input = this.root.querySelector<HTMLInputElement>('[data-import-input]');
      if (input) input.value = '';
    }
  }

  private showImportPreview(project: Project): void {
    const dialog = this.dialog();
    const existing = this.repository.get(project.id);
    const content = element('div', 'dialog-content');
    content.append(element('p', 'eyebrow', 'Review import'), element('h2', 'dialog-title', project.name));
    const preview = element('dl', 'import-preview');
    appendDefinition(preview, 'Project number', project.projectNumber || 'Not set');
    appendDefinition(preview, 'Customer', project.customer || 'Not set');
    appendDefinition(preview, 'Rooms', String(totalRooms(project)));
    appendDefinition(preview, 'Conflict', existing ? 'A local project has the same ID' : 'No matching local project');
    content.append(preview);
    const actions = element('div', 'dialog-actions stacked');
    if (existing) {
      actions.append(button('Replace local project', 'button danger stretch', () => {
        if (this.save(project)) {
          dialog.close();
          this.openProject(project.id);
        }
      }));
    }
    actions.append(button('Import as copy', 'button primary stretch', () => {
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

  private exportProject(project: Project, includePhotos = true): void {
    const exported = includePhotos ? project : structuredClone(project);
    if (!includePhotos) exported.buildings.forEach((building) => building.floors.forEach((floor) => floor.rooms.forEach((room) => { room.photos = []; })));
    const blob = new Blob([serializeProject(exported)], { type: 'application/json' });
    this.downloadBlob(blob, projectFilename(exported));
    this.showToast(includePhotos ? `${project.name} exported` : `${project.name} exported without photos`);
  }

  private async exportRoomPng(project: Project, room: Room): Promise<void> {
    try {
      const blob = await svgToPng(floorPlanSvg(project, room));
      this.downloadBlob(blob, `${safeFilename(room.name)}-plan.png`);
    } catch (error) {
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

  private downloadText(text: string, filename: string, mimeType: string): void {
    this.downloadBlob(new Blob([text], { type: `${mimeType};charset=utf-8` }), filename);
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  private openProject(projectId: string): void {
    this.selectedProjectId = projectId;
    this.setView('plan');
  }

  private selectedProject(): Project | null {
    return this.selectedProjectId ? this.repository.get(this.selectedProjectId) : null;
  }

  private setView(view: PrimaryView): void {
    this.view = view;
    this.render();
  }

  private scheduleSave(project: Project): void {
    this.dirty = true;
    this.saveState = 'saving';
    this.renderSaveIndicator();
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(project), 650);
  }

  private save(project: Project): boolean {
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
      this.notice = error instanceof Error ? error.message : 'The project could not be saved.';
      this.renderSaveIndicator();
      this.renderNotice();
      return false;
    }
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
    toast.replaceChildren(element('span', '', message));
    if (actionLabel && action) toast.append(button(actionLabel, 'toast-action', action));
    toast.hidden = false;
    window.setTimeout(() => {
      toast.hidden = true;
      this.undoDeletion = null;
    }, action ? 30_000 : 4_000);
  }

  private dialog(): HTMLDialogElement {
    const dialog = this.root.querySelector<HTMLDialogElement>('.app-dialog');
    if (!dialog) throw new Error('Application dialog is unavailable.');
    return dialog;
  }

  private openDialog(dialog: HTMLDialogElement): void {
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

function formValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

function navSymbol(view: PrimaryView): string {
  return { projects: 'P', plan: '⌜', measure: '↕', photos: '□', more: '…' }[view];
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
