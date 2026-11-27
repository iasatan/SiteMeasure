import { ObjectLibrary } from '../data/object-library';
import {
  applyPartChange,
  createObjectDefinition,
  descendantIds,
  scaleParts,
  createPart,
  groundAndCenter,
  mirrorParts,
  snapValue,
  objectFilename,
  OBJECT_PRESETS,
  MAX_PARTS,
  ObjectValidationError,
  parseObjectFile,
  partBounds,
  serializeObjects,
  type ObjectDefinition,
  type ObjectPart,
} from '../domain/furniture';
import { createId } from '../domain/models';
import { createObjectPreview, type ObjectPreview } from './object-preview';

export interface ObjectsPageHost {
  layer(): 'technician' | 'designer';
  /** Projects ordered most recently modified first. */
  projects(): Array<{ id: string; name: string }>;
  rooms(projectId: string): Array<{ id: string; name: string }>;
  insert(definition: ObjectDefinition, projectId: string, roomId: string): void;
  openPlan(projectId: string, roomId: string): void;
  download(text: string, filename: string, mimeType: string): void;
  toast(message: string): void;
  confirm(message: string, onConfirm: () => void): void;
}

const EXPERT_KEY = 'sitemeasure.objects.expert';
const HISTORY_LIMIT = 50;
const STEPS_METERS = [0.01, 0.05, 0.1, 0.25];

const PUBLISH_REPOSITORY_URL = 'https://github.com/iasatan/SiteMeasure';

type DimensionKey = 'xMeters' | 'yMeters' | 'zMeters' | 'widthMeters' | 'heightMeters' | 'depthMeters';

const DIMENSION_FIELDS: Array<{ key: DimensionKey; label: string; size: boolean }> = [
  { key: 'widthMeters', label: 'Width (m)', size: true },
  { key: 'heightMeters', label: 'Height (m)', size: true },
  { key: 'depthMeters', label: 'Depth (m)', size: true },
  { key: 'xMeters', label: 'X (m)', size: false },
  { key: 'yMeters', label: 'Y up (m)', size: false },
  { key: 'zMeters', label: 'Z (m)', size: false },
];

export class ObjectsPage {
  private draft: ObjectDefinition = createObjectDefinition('New object', OBJECT_PRESETS[0].build());
  private selectedPartId: string | null = this.draft.parts[0]?.id ?? null;
  private message = '';
  private readonly previewHost = document.createElement('div');
  private preview: ObjectPreview | null | undefined;
  private container: HTMLElement | null = null;
  private targetProjectId: string | null = null;
  private targetRoomId: string | null = null;
  private expert = readExpert();
  private stepMeters = 0.05;
  private snap = true;
  private undoStack: ObjectPart[][] = [];
  private redoStack: ObjectPart[][] = [];

  constructor(private readonly library: ObjectLibrary, private readonly host: ObjectsPageHost) {
    this.previewHost.className = 'object-preview';
  }

  render(main: HTMLElement): void {
    this.container = main;
    if ((this.draft.layer ?? 'designer') !== this.host.layer()) {
      this.draft = createObjectDefinition('New object', [createPart()]);
      this.draft.layer = this.host.layer();
      this.selectedPartId = this.draft.parts[0].id;
    }
    const page = el('section', 'page objects-page');
    const heading = el('div', 'page-heading');
    const title = el('div');
    title.append(el('p', 'eyebrow', 'Furniture and fixtures'), el('h1', '', 'Objects'));
    const tools = el('div', 'project-tools');
    tools.append(
      btn('New', 'button quiet compact', () => this.startNew()),
      btn('Import', 'button quiet compact', () => this.openImport()),
    );
    heading.append(title, tools);
    page.append(heading, this.libraryList(), this.editor());
    main.append(page);
    this.preview ??= createObjectPreview(this.previewHost);
    if (this.preview) this.preview.setParts(this.draft.parts, this.selectedPartId);
    else this.previewHost.textContent = '3D preview needs WebGL, which is not available here.';
  }

  private rerender(): void {
    if (!this.container) return;
    const scroll = window.scrollY;
    this.container.replaceChildren();
    this.render(this.container);
    window.scrollTo(0, scroll);
  }

  private startNew(): void {
    this.draft = createObjectDefinition('New object', [createPart()]);
    this.draft.layer = this.host.layer();
    this.selectedPartId = this.draft.parts[0].id;
    this.message = '';
    this.resetHistory();
    this.rerender();
  }

  private resetHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Call before every change to the parts so it can be undone. */
  private pushHistory(): void {
    this.undoStack.push(this.draft.parts.map((part) => ({ ...part })));
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  private restore(from: ObjectPart[][], to: ObjectPart[][]): void {
    const snapshot = from.pop();
    if (!snapshot) return;
    to.push(this.draft.parts.map((part) => ({ ...part })));
    this.draft.parts = snapshot;
    if (!snapshot.some((part) => part.id === this.selectedPartId)) this.selectedPartId = snapshot[0]?.id ?? null;
    this.rerender();
  }

  private libraryList(): HTMLElement {
    const section = el('section', 'settings-section');
    section.append(el('h2', '', 'Saved objects'));
    const objects = this.library.list().filter((object) => (object.layer ?? 'designer') === this.host.layer());
    if (!objects.length) section.append(el('p', '', 'No saved objects yet. Build one below and save it by name.'));
    const projects = this.host.projects();
    if (!projects.some((project) => project.id === this.targetProjectId)) {
      this.targetProjectId = projects[0]?.id ?? null;
      this.targetRoomId = null;
    }
    const rooms = this.targetProjectId ? this.host.rooms(this.targetProjectId) : [];
    if (!rooms.some((room) => room.id === this.targetRoomId)) this.targetRoomId = rooms[rooms.length - 1]?.id ?? null;
    const projectId = this.targetProjectId;
    const roomId = this.targetRoomId;
    const target = projectId && roomId ? 'selected room' : null;
    if (projects.length) {
      const picker = el('div', 'insert-target');
      picker.append(
        this.select('Project', projects, projectId, (value) => { this.targetProjectId = value; this.targetRoomId = null; this.rerender(); }),
        this.select('Room', rooms, roomId, (value) => { this.targetRoomId = value; this.rerender(); }),
      );
      section.append(picker);
    }
    const templates = el('div', 'insert-target');
    const templateSelect = document.createElement('select');
    templateSelect.className = 'room-selector';
    templateSelect.setAttribute('aria-label', 'Object template');
    const available = OBJECT_PRESETS.filter((preset) => (preset.layer ?? 'designer') === this.host.layer());
    available.forEach((preset, index) => templateSelect.append(new Option(preset.label, String(index))));
    const insertTemplate = btn('Insert template', 'button primary compact', () => {
      const preset = available[Number(templateSelect.value)];
      if (!preset || !projectId || !roomId) return;
      const definition = createObjectDefinition(preset.label, preset.build());
      definition.layer = this.host.layer();
      this.host.insert(definition, projectId, roomId);
    });
    insertTemplate.disabled = !target;
    templates.append(templateSelect, insertTemplate);
    section.append(templates);
    if (projectId && roomId) section.append(btn('Open plan', 'button quiet compact', () => this.host.openPlan(projectId, roomId)));
    for (const object of objects) {
      const row = el('div', 'room-note object-row');
      const bounds = partBounds(object.parts);
      const size = [bounds.widthMeters, bounds.depthMeters, bounds.heightMeters].map((value) => value.toFixed(2)).join(' × ');
      row.append(el('span', '', `${object.name} · ${size} m`));
      row.append(btn('Edit', 'button quiet compact', () => {
        this.draft = { ...object, parts: object.parts.map((part) => ({ ...part })) };
        this.selectedPartId = this.draft.parts[0]?.id ?? null;
        this.message = '';
        this.resetHistory();
        this.rerender();
      }));
      const insert = btn('Insert', 'button primary compact', () => this.host.insert(object, projectId!, roomId!));
      insert.disabled = !target;
      insert.title = target ? 'Insert into the selected room' : 'Create a project with a room first';
      row.append(insert);
      row.append(btn('Export', 'button quiet compact', () => this.exportObjects([object])));
      row.append(btn('Delete', 'button quiet compact', () => {
        try {
          this.library.delete(object.id);
          this.message = '';
        } catch (error) {
          this.message = error instanceof Error ? error.message : 'The object could not be deleted.';
          this.host.toast(this.message);
        }
        this.rerender();
      }));
      section.append(row);
    }
    if (objects.length) section.append(btn('Export all', 'button quiet stretch', () => this.exportObjects(objects)));
    if (!target) section.append(el('p', '', 'Create a project with a room to insert objects.'));
    return section;
  }

  private select(label: string, options: Array<{ id: string; name: string }>, value: string | null, onChange: (value: string) => void): HTMLElement {
    const wrapper = el('label', 'field');
    wrapper.append(el('span', '', label));
    const select = document.createElement('select');
    select.className = 'room-selector';
    for (const option of options) {
      const node = document.createElement('option');
      node.value = option.id;
      node.textContent = option.name;
      node.selected = option.id === value;
      select.append(node);
    }
    select.addEventListener('change', () => onChange(select.value));
    wrapper.append(select);
    return wrapper;
  }

  private editor(): HTMLElement {
    const section = el('section', 'settings-section object-editor');
    const head = el('div', 'object-editor-head');
    head.append(el('h2', '', 'Object editor'));
    const toggle = btn(this.expert ? 'Expert mode: on' : 'Expert mode: off', this.expert ? 'button primary compact' : 'button quiet compact', () => {
      this.expert = !this.expert;
      try { localStorage.setItem(EXPERT_KEY, this.expert ? '1' : '0'); } catch { /* storage unavailable */ }
      this.rerender();
    });
    toggle.setAttribute('aria-pressed', String(this.expert));
    head.append(toggle);
    section.append(head);

    const nameLabel = el('label', 'field');
    const name = document.createElement('input');
    name.type = 'text';
    name.maxLength = 80;
    name.value = this.draft.name;
    name.addEventListener('input', () => { this.draft.name = name.value; });
    nameLabel.append(el('span', 'field-label', 'Name'), name);

    const presetLabel = el('label', 'field');
    const preset = document.createElement('select');
    preset.append(new Option('Start from a template…', ''));
    const groups = new Map<string, HTMLOptGroupElement>();
    OBJECT_PRESETS.forEach((item, index) => {
      if ((item.layer ?? 'designer') !== this.host.layer()) return;
      let group = groups.get(item.category);
      if (!group) {
        group = document.createElement('optgroup');
        group.label = item.category;
        groups.set(item.category, group);
      }
      group.append(new Option(item.label, String(index)));
    });
    [...groups.values()].sort((a, b) => a.label.localeCompare(b.label)).forEach((group) => preset.append(group));
    preset.addEventListener('change', () => {
      const chosen = OBJECT_PRESETS[Number(preset.value)];
      if (!chosen) return;
      this.pushHistory();
      this.draft.parts = chosen.build();
      if (!name.value.trim() || name.value === 'New object') this.draft.name = chosen.label;
      this.selectedPartId = this.draft.parts[0].id;
      this.rerender();
    });
    presetLabel.append(el('span', 'field-label', 'Template'), preset);

    const dims = el('div', 'object-part-fields');
    const bounds = partBounds(this.draft.parts);
    for (const [label, key, value] of [['Overall width (m)', 'widthMeters', bounds.widthMeters], ['Overall height (m)', 'heightMeters', bounds.heightMeters], ['Overall depth (m)', 'depthMeters', bounds.depthMeters]] as const) {
      const wrapper = el('label', 'field');
      const input = document.createElement('input');
      input.type = 'number';
      input.step = '0.05';
      input.min = '0.01';
      input.value = String(round(value));
      input.addEventListener('change', () => {
        const next = Number(input.value);
        if (Number.isFinite(next) && next >= 0.01 && next <= 100) {
          this.pushHistory();
          scaleParts(this.draft.parts, { [key]: next });
        }
        this.rerender();
      });
      wrapper.append(el('span', 'field-label', label), input);
      dims.append(wrapper);
    }
    const updateDims = () => {
      const current = partBounds(this.draft.parts);
      const inputs = dims.querySelectorAll('input');
      [current.widthMeters, current.heightMeters, current.depthMeters].forEach((value, index) => { inputs[index].value = String(round(value)); });
    };

    section.append(nameLabel, presetLabel, this.previewHost, ...(this.expert ? [this.expertToolbar()] : []), dims, el('p', 'field-hint', 'Changing the overall size scales every part, so attached parts stay together.'), this.partsEditor(updateDims));

    const error = el('p', this.message.startsWith('Saved') ? 'field-hint' : 'field-error', this.message);
    error.setAttribute('role', 'alert');
    const actions = el('div', 'dialog-actions');
    actions.append(
      btn('Save by name', 'button primary', () => this.saveDraft()),
      btn('Export file', 'button quiet', () => this.exportObjects([this.draft])),
      btn('Publish', 'button quiet', () => this.publishDraft()),
    );
    section.append(error, actions);
    return section;
  }

  private partsEditor(updateDims: () => void): HTMLElement {
    const wrap = el('div', 'object-parts');
    const list = el('div', 'object-part-list');
    this.draft.parts.forEach((part, index) => {
      const item = btn(`${index + 1}. ${part.shape === 'box' ? 'Box' : 'Cylinder'}`, part.id === this.selectedPartId ? 'button primary compact' : 'button quiet compact', () => {
        this.selectedPartId = part.id;
        this.rerender();
      });
      list.append(item);
    });
    const add = btn('Add part', 'button quiet compact', () => {
      if (this.draft.parts.length >= MAX_PARTS) return;
      this.pushHistory();
      const part = createPart();
      this.draft.parts.push(part);
      this.selectedPartId = part.id;
      this.rerender();
    });
    list.append(add);
    wrap.append(list);

    const selected = this.draft.parts.find((part) => part.id === this.selectedPartId);
    if (!selected) return wrap;

    const refresh = () => {
      updateDims();
      this.preview?.setParts(this.draft.parts, this.selectedPartId);
    };
    const grid = el('div', 'object-part-fields');

    const shapeLabel = el('label', 'field');
    const shape = document.createElement('select');
    shape.append(new Option('Box', 'box'), new Option('Cylinder', 'cylinder'));
    shape.value = selected.shape;
    shape.addEventListener('change', () => {
      this.pushHistory();
      selected.shape = shape.value === 'cylinder' ? 'cylinder' : 'box';
      this.rerender();
    });
    shapeLabel.append(el('span', 'field-label', 'Shape'), shape);
    grid.append(shapeLabel);

    for (const field of DIMENSION_FIELDS) {
      const label = el('label', 'field');
      const input = document.createElement('input');
      input.type = 'number';
      input.step = '0.05';
      if (field.size) input.min = '0.01';
      input.value = String(round(selected[field.key]));
      input.addEventListener('change', () => {
        const value = Number(input.value);
        const valid = Number.isFinite(value) && (field.size ? value >= 0.01 && value <= 100 : Math.abs(value) <= 100);
        if (!valid) {
          input.value = String(round(selected[field.key]));
          return;
        }
        this.pushHistory();
        applyPartChange(this.draft.parts, selected.id, { [field.key]: value });
        refresh();
      });
      label.append(el('span', 'field-label', field.label), input);
      grid.append(label);
    }

    const attachLabel = el('label', 'field');
    const attach = document.createElement('select');
    attach.append(new Option('Nothing (free)', ''));
    const blocked = descendantIds(this.draft.parts, selected.id);
    this.draft.parts.forEach((part, index) => {
      if (part.id !== selected.id && !blocked.has(part.id)) attach.append(new Option(`${index + 1}. ${part.shape === 'box' ? 'Box' : 'Cylinder'}`, part.id));
    });
    attach.value = selected.parentId ?? '';
    attach.addEventListener('change', () => {
      this.pushHistory();
      if (attach.value) selected.parentId = attach.value;
      else delete selected.parentId;
    });
    attachLabel.append(el('span', 'field-label', 'Sticks to'), attach);
    grid.append(attachLabel);

    const colorLabel = el('label', 'field');
    const color = document.createElement('input');
    color.type = 'color';
    color.value = selected.color;
    color.addEventListener('focus', () => this.pushHistory());
    color.addEventListener('input', () => {
      selected.color = color.value;
      refresh();
    });
    colorLabel.append(el('span', 'field-label', 'Colour'), color);
    grid.append(colorLabel);
    if (this.expert) {
      const details = el('details', 'object-expert-details');
      details.append(el('summary', '', 'Exact values'), grid);
      wrap.append(this.expertTools(selected), details);
    } else {
      wrap.append(grid);
    }

    const actions = el('div', 'dialog-actions');
    actions.append(
      btn('Duplicate part', 'button quiet compact', () => {
        if (this.draft.parts.length >= MAX_PARTS) return;
        this.pushHistory();
        const copy: ObjectPart = { ...selected, id: createId(), xMeters: selected.xMeters + 0.1 };
        this.draft.parts.push(copy);
        this.selectedPartId = copy.id;
        this.rerender();
      }),
      btn('Remove part', 'button quiet compact', () => {
        if (this.draft.parts.length <= 1) {
          this.message = 'An object needs at least one part.';
          this.rerender();
          return;
        }
        this.pushHistory();
        this.draft.parts = this.draft.parts.filter((part) => part.id !== selected.id);
        for (const part of this.draft.parts) {
          if (part.parentId !== selected.id) continue;
          if (selected.parentId !== undefined) part.parentId = selected.parentId;
          else delete part.parentId;
        }
        this.selectedPartId = this.draft.parts[0].id;
        this.rerender();
      }),
    );
    wrap.append(actions);
    return wrap;
  }

  private expertToolbar(): HTMLElement {
    const bar = el('div', 'object-expert-bar');
    const undo = btn('Undo', 'button quiet compact', () => this.restore(this.undoStack, this.redoStack));
    undo.disabled = !this.undoStack.length;
    const redo = btn('Redo', 'button quiet compact', () => this.restore(this.redoStack, this.undoStack));
    redo.disabled = !this.redoStack.length;
    const whole = (label: string, action: () => void) => btn(label, 'button quiet compact', () => {
      this.pushHistory();
      action();
      this.rerender();
    });
    bar.append(
      undo,
      redo,
      whole('Drop to floor', () => groundAndCenter(this.draft.parts)),
      whole('Mirror ↔', () => mirrorParts(this.draft.parts, 'x')),
      whole('Mirror ↕', () => mirrorParts(this.draft.parts, 'z')),
    );
    return bar;
  }

  /** Large touch-friendly step buttons for moving and resizing the selected part. */
  private expertTools(selected: ObjectPart): HTMLElement {
    const panel = el('div', 'object-expert');
    const steps = el('div', 'object-expert-steps');
    steps.setAttribute('role', 'group');
    steps.setAttribute('aria-label', 'Step size');
    for (const step of STEPS_METERS) {
      steps.append(btn(`${step * 100} cm`, step === this.stepMeters ? 'button primary compact' : 'button quiet compact', () => { this.stepMeters = step; this.rerender(); }));
    }
    const snap = btn(this.snap ? 'Snap: on' : 'Snap: off', this.snap ? 'button primary compact' : 'button quiet compact', () => { this.snap = !this.snap; this.rerender(); });
    snap.setAttribute('aria-pressed', String(this.snap));
    steps.append(snap);
    panel.append(steps);

    const change = (key: DimensionKey, direction: number, size: boolean) => {
      const raw = selected[key] + direction * this.stepMeters;
      const next = this.snap ? snapValue(raw, this.stepMeters) : round(raw);
      if (size ? next < 0.01 || next > 100 : Math.abs(next) > 100) return;
      this.pushHistory();
      applyPartChange(this.draft.parts, selected.id, { [key]: next });
      this.rerender();
    };
    const group = (title: string, size: boolean, axes: Array<[string, DimensionKey]>) => {
      const box = el('div', 'object-expert-group');
      box.append(el('span', 'field-label', title));
      const pad = el('div', 'object-expert-pad');
      for (const [label, key] of axes) {
        const cell = el('div', 'object-expert-axis');
        cell.append(
          btn('−', 'button quiet', () => change(key, -1, size)),
          el('span', '', `${label} ${round(selected[key])}`),
          btn('+', 'button quiet', () => change(key, 1, size)),
        );
        pad.append(cell);
      }
      box.append(pad);
      return box;
    };
    panel.append(
      group('Move (m)', false, [['X', 'xMeters'], ['Y up', 'yMeters'], ['Z', 'zMeters']]),
      group('Size (m)', true, [['W', 'widthMeters'], ['H', 'heightMeters'], ['D', 'depthMeters']]),
    );
    return panel;
  }

  private saveDraft(confirmed = false): void {
    if (!this.draft.name.trim()) {
      this.message = 'Enter a name for the object.';
      this.rerender();
      return;
    }
    const existing = this.library.list().find((item) => item.name.toLowerCase() === this.draft.name.trim().toLowerCase() && item.id !== this.draft.id);
    if (existing && !confirmed) {
      this.host.confirm(`Replace the saved object "${existing.name}"?`, () => this.saveDraft(true));
      return;
    }
    try {
      this.draft = this.library.save({ ...this.draft, name: this.draft.name.trim() });
      this.message = `Saved "${this.draft.name}".`;
    } catch (error) {
      this.message = error instanceof Error ? error.message : 'The object could not be saved.';
    }
    this.rerender();
  }

  /** Opens GitHub's "propose new file" page, which creates a branch and pull request (via a fork when needed). */
  private publishDraft(): void {
    if (!this.draft.name.trim()) {
      this.message = 'Enter a name for the object.';
      this.rerender();
      return;
    }
    try {
      const object = { ...this.draft, name: this.draft.name.trim() };
      const params = new URLSearchParams({
        filename: `objects/${objectFilename([object])}`,
        value: serializeObjects([object]),
        message: `Add object: ${object.name}`,
      });
      const url = `${PUBLISH_REPOSITORY_URL}/new/main?${params}`;
      if (url.length > 8000) {
        this.host.toast('This object is too large to publish directly. Export the file and add it to the repository manually.');
        return;
      }
      window.open(url, '_blank', 'noopener');
      this.host.toast('Opening GitHub. Choose "Propose new file", then "Create pull request".');
    } catch (error) {
      this.host.toast(error instanceof Error ? error.message : 'Publish failed.');
    }
  }

  private exportObjects(objects: ObjectDefinition[]): void {
    try {
      this.host.download(serializeObjects(objects), objectFilename(objects), 'application/json');
    } catch (error) {
      this.host.toast(error instanceof Error ? error.message : 'Export failed.');
    }
  }

  private openImport(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        this.host.toast('The object file is larger than 5 MB.');
        return;
      }
      void file.text().then((text) => {
        try {
          const imported = this.library.importAll(parseObjectFile(text));
          this.host.toast(`Imported ${imported.length} object${imported.length === 1 ? '' : 's'}.`);
          this.rerender();
        } catch (error) {
          this.host.toast(error instanceof ObjectValidationError ? error.message : 'The object file could not be imported.');
        }
      });
    });
    input.click();
  }
}

function readExpert(): boolean {
  try { return localStorage.getItem(EXPERT_KEY) === '1'; } catch { return false; }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text) result.textContent = text;
  return result;
}

function btn(label: string, className: string, action: () => void): HTMLButtonElement {
  const result = document.createElement('button');
  result.type = 'button';
  result.className = className;
  result.textContent = label;
  result.addEventListener('click', action);
  return result;
}
