import { copyImportedProject, projectFilename, readProjectFile, serializeProject } from './data/project-files';
import { LocalStorageProjectRepository, type RepositoryWarning } from './data/local-storage-repository';
import { createId, createProject, createRoom, type Project, type ProjectSummary, type Room } from './domain/models';
import { FloorPlanEditor, type EditorSelection } from './editor/floor-plan-editor';
import { distanceBetween, formatLength, openingArea, polygonIssues, roomArea, roomVolume, wallArea } from './geometry';

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
      <div class="toast" role="status" aria-live="polite" hidden></div>
    `;

    this.root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
      button.addEventListener('click', () => this.setView(button.dataset.view as PrimaryView));
    });
    this.root.querySelector<HTMLInputElement>('[data-import-input]')?.addEventListener('change', (event) => {
      void this.handleImport((event.currentTarget as HTMLInputElement).files?.[0]);
    });
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
        this.renderUnavailableView(main, 'Photos', 'Photos and annotations will be available in the next implementation phase.');
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
        const editLength = button('Edit length', 'button primary stretch', () => this.showMeasurementDialog(project, room, wall));
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
    content.append(target, field, actions);
    dialog.replaceChildren(content);
    this.openDialog(dialog);
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
      row.append(element('span', '', `${room.name} · ${measurement.source} · ${formatDate(measurement.capturedAt)}`));
      list.append(row);
    }
    page.append(list, button('Open plan', 'button quiet stretch', () => this.setView('plan')));
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
    storage.append(element('p', 'storage-warning', 'Clearing Safari website data can delete local projects. Export important projects regularly.'));
    const actions = element('section', 'settings-section');
    actions.append(element('h2', '', 'Project files'));
    actions.append(button('Import project', 'button primary stretch', () => this.openImportPicker()));
    const current = this.selectedProject();
    if (current) actions.append(button('Export open project', 'button quiet stretch', () => this.exportProject(current)));
    page.append(storage, actions);
    main.append(page);
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

  private exportProject(project: Project): void {
    const blob = new Blob([serializeProject(project)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = projectFilename(project);
    link.click();
    URL.revokeObjectURL(url);
    this.showToast(`${project.name} exported`);
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

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unitIndex).toFixed(unitIndex ? 1 : 0)} ${units[unitIndex]}`;
}
