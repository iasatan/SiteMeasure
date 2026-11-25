import { createId, DEFAULT_DOOR_HEIGHT_METERS, DEFAULT_WINDOW_HEIGHT_METERS, type Door, type EditingLayer, type Measurement, type Point, type Room, type RoomObject, type Wall, type Window } from '../domain/models';
import { cornerAngleDegrees, distanceBetween, formatLength, nearestPointOnSegment, perpendicularPoint, pointOnWall, polygonIssues, roomArea, roomHeight, setCornerAngle, snapPoint, wallElevation } from '../geometry';

export type EditorTool = 'select' | 'wall' | 'room' | 'door' | 'window' | 'object' | 'measure';
export type EditorSelection = { type: 'wall' | 'room' | 'object' | 'door' | 'window'; id: string } | null;

export interface FloorPlanEditorOptions {
  room: Room;
  units: 'metric' | 'imperial';
  layer?: EditingLayer;
  onChange(room: Room, completed: boolean): void;
  onSelection(selection: EditorSelection): void;
  onMeasure?(wall: Wall): void;
  onMeasureObject?(id: string): void;
  onOpening?(kind: OpeningKind, id: string): void;
}

export type OpeningKind = 'door' | 'window';

interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PointerSnapshot {
  id: number;
  screenX: number;
  screenY: number;
  world: Point;
}

export class FloorPlanEditor {
  readonly element: HTMLElement;
  private room: Room;
  private readonly units: 'metric' | 'imperial';
  private readonly layer: EditingLayer | undefined;
  private readonly onChange: FloorPlanEditorOptions['onChange'];
  private readonly onSelection: FloorPlanEditorOptions['onSelection'];
  private readonly onMeasure: FloorPlanEditorOptions['onMeasure'];
  private readonly onMeasureObject: FloorPlanEditorOptions['onMeasureObject'];
  private readonly onOpening: FloorPlanEditorOptions['onOpening'];
  private readonly svg: SVGSVGElement;
  private readonly controls: HTMLElement;
  private readonly viewControls: HTMLElement;
  private readonly summary: HTMLElement;
  private tool: EditorTool = 'select';
  private selection: EditorSelection = null;
  private drawingPoints: Point[] = [];
  private wallStart: Point | null = null;
  private objectStart: Point | null = null;
  private view = 'floor';
  private resizingObject = false;
  private readonly pointers = new Map<number, PointerSnapshot>();
  private dragOrigin: Point | null = null;
  private dragEndpoint: 'start' | 'end' | null = null;
  private originalRoom: Room | null = null;
  private panOrigin: Point | null = null;
  private originalViewBox: ViewBox | null = null;
  private pinchDistance = 0;
  private pinchStartViewBox: ViewBox | null = null;
  private doubleClickSelection: EditorSelection = null;
  private lastPointerUpAt = 0;
  private lastPointerSelection: EditorSelection = null;
  private lastHandledDoubleClickAt = 0;
  private viewBox: ViewBox = { x: -1, y: -1, width: 14, height: 11 };
  private readonly undoStack: Room[] = [];
  private redoStack: Room[] = [];
  private copiedWall: Wall | null = null;
  private showGrid = true;
  private snap = true;
  private rightAngles = true;

  constructor(options: FloorPlanEditorOptions) {
    this.room = structuredClone(options.room);
    this.units = options.units;
    this.layer = options.layer;
    this.onChange = options.onChange;
    this.onSelection = options.onSelection;
    this.onMeasure = options.onMeasure;
    this.onMeasureObject = options.onMeasureObject;
    this.onOpening = options.onOpening;
    this.element = document.createElement('div');
    this.element.className = 'floor-editor';

    this.controls = document.createElement('div');
    this.controls.className = 'editor-tool-row';
    this.controls.setAttribute('aria-label', 'Floor plan tools');
    this.viewControls = document.createElement('div');
    this.viewControls.className = 'editor-view-row';
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.classList.add('editor-svg');
    this.svg.setAttribute('role', 'application');
    this.svg.setAttribute('aria-label', `Editable floor plan for ${this.room.name}`);
    this.summary = document.createElement('div');
    this.summary.className = 'editor-summary';
    this.summary.setAttribute('aria-live', 'polite');

    this.element.append(this.viewControls, this.buildUtilityRow(), this.svg, this.summary, this.controls);
    this.bindPointerEvents();
    this.render();
    this.fitDrawing();
  }

  setRoom(room: Room): void {
    this.room = structuredClone(room);
    this.selection = null;
    this.render();
  }

  getRoom(): Room {
    return structuredClone(this.room);
  }

  setTool(tool: EditorTool): void {
    if (!this.allowedTools().includes(tool)) return;
    this.tool = tool;
    this.wallStart = null;
    this.objectStart = null;
    this.drawingPoints = [];
    this.render();
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(structuredClone(this.room));
    this.room = previous;
    this.selection = null;
    this.onSelection(null);
    this.onChange(structuredClone(this.room), true);
    this.render();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(structuredClone(this.room));
    this.room = next;
    this.onChange(structuredClone(this.room), true);
    this.render();
  }

  splitSelection(): void {
    const wall = this.selectedWall();
    if (!wall || wall.locked) return;
    this.beginAction();
    const midpoint = { xMeters: (wall.start.xMeters + wall.end.xMeters) / 2, yMeters: (wall.start.yMeters + wall.end.yMeters) / 2 };
    const second = structuredClone(wall);
    second.id = createId();
    second.start = structuredClone(midpoint);
    delete second.lengthMeters;
    wall.end = structuredClone(midpoint);
    delete wall.lengthMeters;
    this.room.walls.splice(this.room.walls.indexOf(wall) + 1, 0, second);
    this.commitAction();
  }

  joinSelection(): void {
    const wall = this.selectedWall();
    if (!wall || wall.locked) return;
    const neighbor = this.room.walls.find((candidate) => candidate.id !== wall.id && distanceBetween(candidate.start, wall.end) < 0.05);
    if (!neighbor) return;
    const firstVector = { xMeters: wall.end.xMeters - wall.start.xMeters, yMeters: wall.end.yMeters - wall.start.yMeters };
    const secondVector = { xMeters: neighbor.end.xMeters - neighbor.start.xMeters, yMeters: neighbor.end.yMeters - neighbor.start.yMeters };
    if (Math.abs(firstVector.xMeters * secondVector.yMeters - firstVector.yMeters * secondVector.xMeters) > 0.001) return;
    this.beginAction();
    wall.end = structuredClone(neighbor.end);
    delete wall.lengthMeters;
    this.room.walls = this.room.walls.filter((candidate) => candidate.id !== neighbor.id);
    this.room.doors.forEach((door) => { if (door.wallId === neighbor.id) door.wallId = wall.id; });
    this.room.windows.forEach((window) => { if (window.wallId === neighbor.id) window.wallId = wall.id; });
    this.commitAction();
  }

  duplicateSelection(): void {
    const source = this.selectedWall();
    if (!source) return;
    this.beginAction();
    const wall = structuredClone(source);
    wall.id = createId();
    wall.start.yMeters += 0.25;
    wall.end.yMeters += 0.25;
    delete wall.lengthMeters;
    this.room.walls.push(wall);
    this.selection = { type: 'wall', id: wall.id };
    this.commitAction();
  }

  copySelection(): void {
    const wall = this.selectedWall();
    this.copiedWall = wall ? structuredClone(wall) : null;
  }

  pasteSelection(): void {
    if (!this.copiedWall) return;
    this.beginAction();
    const wall = structuredClone(this.copiedWall);
    wall.id = createId();
    wall.start.yMeters += 0.5;
    wall.end.yMeters += 0.5;
    delete wall.lengthMeters;
    wall.locked = false;
    this.room.walls.push(wall);
    this.selection = { type: 'wall', id: wall.id };
    this.commitAction();
  }

  toggleLockSelection(): void {
    const wall = this.selectedWall();
    if (!wall) return;
    this.beginAction();
    wall.locked = !wall.locked;
    this.commitAction();
  }

  canPaste(): boolean {
    return this.copiedWall !== null;
  }

  rotateSelection(): void {
    const wall = this.selectedWall();
    if (!wall) return;
    this.beginAction();
    const center = { xMeters: (wall.start.xMeters + wall.end.xMeters) / 2, yMeters: (wall.start.yMeters + wall.end.yMeters) / 2 };
    wall.start = rotatePoint(wall.start, center);
    wall.end = rotatePoint(wall.end, center);
    delete wall.lengthMeters;
    this.commitAction();
  }

  deleteSelection(): void {
    if (!this.selection || !this.canEditSelection(this.selection)) return;
    this.beginAction();
    if (this.selection.type === 'object') {
      this.room.objects = this.room.objects.filter((object) => object.id !== this.selection?.id);
    } else if (this.selection.type === 'wall') {
      this.room.walls = this.room.walls.filter((wall) => wall.id !== this.selection?.id);
      this.room.doors = this.room.doors.filter((door) => door.wallId !== this.selection?.id && door.rightWallId !== this.selection?.id);
      this.room.windows = this.room.windows.filter((window) => window.wallId !== this.selection?.id && window.rightWallId !== this.selection?.id);
    } else if (this.selection.type === 'door' || this.selection.type === 'window') {
      this.removeOpening(this.selection.type, this.selection.id);
    } else {
      this.room.points = [];
      this.room.walls = [];
      this.room.doors = [];
      this.room.windows = [];
    }
    this.selection = null;
    this.onSelection(null);
    this.commitAction();
  }

  getSelectedWall(): Wall | null {
    return this.selectedWall() ? structuredClone(this.selectedWall() as Wall) : null;
  }

  setWallLength(lengthMeters: number, measurement?: Measurement): boolean {
    const wall = this.selectedWall();
    if (!wall || wall.locked || !Number.isFinite(lengthMeters) || lengthMeters <= 0) return false;
    this.beginAction();
    this.resizeWall(wall, lengthMeters);
    this.commitAction(measurement);
    return true;
  }

  applySelectedMeasurement(measurement: Measurement): boolean {
    const selection = this.selection;
    const value = measurement.valueMeters;
    if (!selection || selection.type === 'room' || selection.id !== measurement.targetId || !Number.isFinite(value) || value < 0.001 || value > 1_000_000 || !this.canEditSelection(selection)) return false;
    if (selection.type === 'wall') {
      const wall = this.selectedWall();
      if (!wall || wall.locked) return false;
      this.setWallLength(value, measurement);
      return true;
    }
    if (selection.type === 'object') return value <= 1000 && this.updateObject(selection.id, { widthMeters: value }, measurement);
    const found = this.getOpening(selection.type, selection.id);
    if (!found) return false;
    return this.updateOpening(selection.type, selection.id, distanceBetween(found.wall.start, found.wall.end), found.opening.offsetMeters, value, undefined, measurement);
  }

  getCornerAngle(): number | null {
    const wall = this.selectedWall();
    return wall ? cornerAngleDegrees(this.room.walls, this.room.walls.indexOf(wall)) : null;
  }

  setCornerAngle(degrees: number): boolean {
    const wall = this.selectedWall();
    if (!wall) return false;
    const preview = structuredClone(this.room.walls);
    if (!setCornerAngle(preview, this.room.walls.indexOf(wall), degrees)) return false;
    this.beginAction();
    setCornerAngle(this.room.walls, this.room.walls.indexOf(wall), degrees);
    this.syncPolygonFromWalls();
    this.commitAction();
    return true;
  }

  getOpening(kind: OpeningKind, id: string): { opening: Door | Window; wall: Wall } | null {
    const opening = (kind === 'door' ? this.room.doors : this.room.windows).find((candidate) => candidate.id === id);
    if (!opening) return null;
    const leftWall = this.room.walls.find((candidate) => candidate.id === opening.wallId);
    if (!leftWall) return null;
    const rightWall = opening.rightWallId ? this.room.walls.find((candidate) => candidate.id === opening.rightWallId) : null;
    if (rightWall) {
      const logicalWall = structuredClone(leftWall);
      logicalWall.end = structuredClone(rightWall.end);
      delete logicalWall.lengthMeters;
      return { opening: { ...structuredClone(opening), offsetMeters: distanceBetween(leftWall.start, leftWall.end) }, wall: logicalWall };
    }
    return structuredClone({ opening, wall: leftWall });
  }

  updateOpening(kind: OpeningKind, id: string, wallLengthMeters: number, offsetMeters: number, widthMeters: number, heightMeters?: number, measurement?: Measurement): boolean {
    if (!this.canEditSelection({ type: kind, id })) return false;
    const openings = kind === 'door' ? this.room.doors : this.room.windows;
    const opening = openings.find((candidate) => candidate.id === id);
    const leftWall = opening ? this.room.walls.find((candidate) => candidate.id === opening.wallId) : undefined;
    if (!opening || !leftWall || wallLengthMeters <= 0 || widthMeters <= 0 || offsetMeters < 0) return false;
    if (offsetMeters + widthMeters > wallLengthMeters + 1e-9) return false;
    const rightWall = opening.rightWallId ? this.room.walls.find((candidate) => candidate.id === opening.rightWallId) : undefined;
    if (opening.rightWallId && (!rightWall || offsetMeters <= 0 || offsetMeters + widthMeters >= wallLengthMeters)) return false;
    this.beginAction();
    if (rightWall) this.resizeSplitOpening(leftWall, rightWall, wallLengthMeters, offsetMeters, widthMeters);
    else if (Math.abs(wallLengthMeters - distanceBetween(leftWall.start, leftWall.end)) > 1e-9) this.resizeWall(leftWall, wallLengthMeters);
    opening.offsetMeters = offsetMeters;
    opening.widthMeters = widthMeters;
    if (heightMeters !== undefined) opening.heightMeters = heightMeters;
    this.commitAction(measurement);
    return true;
  }

  getWallOpenings(): Array<{ kind: OpeningKind; opening: Door | Window }> {
    const wall = this.selectedWall();
    if (!wall) return [];
    return [
      ...this.room.doors.filter((door) => door.wallId === wall.id || door.rightWallId === wall.id).map((opening) => ({ kind: 'door' as const, opening: structuredClone(opening) })),
      ...this.room.windows.filter((window) => window.wallId === wall.id || window.rightWallId === wall.id).map((opening) => ({ kind: 'window' as const, opening: structuredClone(opening) })),
    ];
  }

  addDoorToSelectedWall(widthMeters = 0.9): void {
    this.addOpening('door', widthMeters);
  }

  addWindowToSelectedWall(widthMeters = 1.2): void {
    this.addOpening('window', widthMeters);
  }

  private addOpening(type: 'door' | 'window', widthMeters: number): void {
    const wall = this.selectedWall();
    if (!wall) return;
    const length = distanceBetween(wall.start, wall.end);
    if (length <= widthMeters + 0.1) return;
    const offsetMeters = (length - widthMeters) / 2;
    const opening = { id: createId(), wallId: wall.id, offsetMeters, widthMeters };
    const existing = [...this.room.doors, ...this.room.windows].filter((candidate) => !candidate.rightWallId && candidate.wallId === wall.id);
    if (!this.canSplitWallForOpenings(wall, [...existing, opening])) return;
    this.beginAction();
    this.splitWallForOpenings(wall, [...existing, opening]);
    if (type === 'door') this.room.doors.push(opening as Door);
    else this.room.windows.push(opening as Window);
    this.commitAction();
    this.onOpening?.(type, opening.id);
  }

  private buildUtilityRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'editor-utility-row';
    row.append(
      this.actionButton('-', 'Zoom out', () => this.zoomAtCenter(0.8)),
      this.actionButton('+', 'Zoom in', () => this.zoomAtCenter(1.25)),
      this.actionButton('Fit', 'Fit drawing', () => this.fitDrawing()),
      this.actionButton('Grid', 'Toggle grid', (button) => {
        this.showGrid = !this.showGrid;
        button?.classList.toggle('is-active', this.showGrid);
        this.render();
      }, this.showGrid),
      this.actionButton('Snap', 'Toggle snapping', (button) => {
        this.snap = !this.snap;
        button?.classList.toggle('is-active', this.snap);
      }, this.snap),
      this.actionButton('90°', 'Toggle right-angle corners while drawing', (button) => {
        this.rightAngles = !this.rightAngles;
        button?.classList.toggle('is-active', this.rightAngles);
      }, this.rightAngles),
    );
    return row;
  }

  private actionButton(text: string, label: string, action: (button?: HTMLButtonElement) => void, active = false): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = active ? 'editor-icon-button is-active' : 'editor-icon-button';
    button.textContent = text;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', () => action(button));
    return button;
  }

  private bindPointerEvents(): void {
    this.svg.addEventListener('pointerdown', (event) => this.pointerDown(event));
    this.svg.addEventListener('pointermove', (event) => this.pointerMove(event));
    this.svg.addEventListener('pointerup', (event) => this.pointerUp(event));
    this.svg.addEventListener('pointercancel', (event) => this.pointerUp(event));
    this.svg.addEventListener('dblclick', (event) => {
      event.preventDefault();
      if (performance.now() - this.lastHandledDoubleClickAt < 500) return;
      const target = (event.target as Element).closest<SVGElement>('[data-wall-id], [data-opening-id], [data-object-id], [data-room-id]');
      this.handleDoubleClick(this.doubleClickSelection ? null : target, this.doubleClickSelection);
    });
  }

  private handleDoubleClick(target: SVGElement | null, fallback: EditorSelection = null): void {
    if (target?.dataset.openingId && (target.dataset.openingType === 'door' || target.dataset.openingType === 'window')) {
      fallback = { type: target.dataset.openingType, id: target.dataset.openingId };
    } else if (target?.dataset.wallId) fallback = { type: 'wall', id: target.dataset.wallId };
    else if (target?.dataset.objectId) fallback = { type: 'object', id: target.dataset.objectId };
    if (fallback && !this.canEditSelection(fallback)) return;
    if (fallback?.type === 'door' || fallback?.type === 'window') {
      this.select(fallback);
      this.onOpening?.(fallback.type, fallback.id);
      return;
    }
    if (fallback?.type === 'wall') {
      const wall = this.room.walls.find((candidate) => candidate.id === fallback.id);
      if (!wall) return;
      this.select(fallback);
      this.onMeasure?.(structuredClone(wall));
      return;
    }
    if (fallback?.type === 'object') {
      this.select(fallback);
      this.onMeasureObject?.(fallback.id);
      return;
    }
    this.fitSelection();
  }

  private pointerDown(event: PointerEvent): void {
    event.preventDefault();
    try {
      this.svg.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic and interrupted pointer events may not have an active capture.
    }
    const world = this.pointerWorld(event);
    this.pointers.set(event.pointerId, { id: event.pointerId, screenX: event.clientX, screenY: event.clientY, world });

    if (this.pointers.size === 2) {
      const [first, second] = [...this.pointers.values()];
      this.pinchDistance = Math.hypot(second.screenX - first.screenX, second.screenY - first.screenY);
      this.pinchStartViewBox = { ...this.viewBox };
      return;
    }

    let target = (event.target as Element).closest<SVGElement>('[data-wall-id], [data-opening-id], [data-object-id], [data-room-id]');
    if (this.tool === 'select') target = this.nearestSelectionTarget(world, target);
    this.doubleClickSelection = target?.dataset.openingId && (target.dataset.openingType === 'door' || target.dataset.openingType === 'window')
      ? { type: target.dataset.openingType, id: target.dataset.openingId }
      : target?.dataset.wallId
        ? { type: 'wall', id: target.dataset.wallId }
        : target?.dataset.objectId
          ? { type: 'object', id: target.dataset.objectId }
          : null;
    if (this.handleToolPointer(world, target)) return;
    this.handleSelectionPointer(world, target);
  }

  private handleToolPointer(world: Point, target: SVGElement | null): boolean {
    if (this.tool === 'wall') this.addWallPoint(world);
    else if (this.tool === 'room') this.addRoomPoint(world);
    else if (this.tool === 'door' || this.tool === 'window') this.handleOpeningPointer(world, target);
    else if (this.tool === 'object') this.addObjectPoint(world);
    else if (this.tool === 'measure') this.handleMeasurePointer(target);
    else return false;
    return true;
  }

  private handleOpeningPointer(world: Point, target: SVGElement | null): void {
    const wall = this.room.walls.find((candidate) => candidate.id === target?.dataset.wallId);
    if (!wall) return;
    this.select({ type: 'wall', id: wall.id });
    this.addOpeningAt(this.tool, wall, world);
  }

  private handleMeasurePointer(target: SVGElement | null): void {
    if (target?.dataset.objectId) {
      if (!this.canEditSelection({ type: 'object', id: target.dataset.objectId })) return;
      this.select({ type: 'object', id: target.dataset.objectId });
      this.onMeasureObject?.(target.dataset.objectId);
      return;
    }
    const wall = this.room.walls.find((candidate) => candidate.id === target?.dataset.wallId);
    if (!wall) return;
    if (!this.canEditSelection({ type: 'wall', id: wall.id })) return;
    this.select({ type: 'wall', id: wall.id });
    this.onMeasure?.(structuredClone(wall));
  }

  private nearestSelectionTarget(world: Point, target: SVGElement | null): SVGElement | null {
    if (target?.dataset.endpoint || target?.dataset.resizeObject === 'true') return target;
    const matrix = this.svg.getScreenCTM?.();
    const scale = matrix ? Math.hypot(matrix.a, matrix.b) : 0;
    const tolerance = scale ? 20 / scale : this.viewBox.width * 20 / Math.max(this.svg.clientWidth, 300);
    let nearest: SVGElement | null = null;
    let nearestDistance = tolerance;
    const candidates = this.svg.querySelectorAll<SVGElement>('line.editor-wall, line.editor-opening, rect.editor-object');
    for (const candidate of candidates) {
      let selection: EditorSelection = null;
      if (candidate.dataset.openingId && (candidate.dataset.openingType === 'door' || candidate.dataset.openingType === 'window')) {
        selection = { type: candidate.dataset.openingType, id: candidate.dataset.openingId };
      } else if (candidate.dataset.wallId) selection = { type: 'wall', id: candidate.dataset.wallId };
      else if (candidate.dataset.objectId) selection = { type: 'object', id: candidate.dataset.objectId };
      if (!selection || !this.canEditSelection(selection)) continue;
      const distance = this.selectionTargetDistance(world, candidate, selection);
      if (distance <= nearestDistance) {
        nearest = candidate;
        nearestDistance = distance;
      }
    }
    return nearest ?? target;
  }

  private selectionTargetDistance(world: Point, candidate: SVGElement, selection: NonNullable<EditorSelection>): number {
    if (candidate.tagName.toLowerCase() === 'line') {
      const start = { xMeters: Number(candidate.getAttribute('x1')), yMeters: Number(candidate.getAttribute('y1')) };
      const end = { xMeters: Number(candidate.getAttribute('x2')), yMeters: Number(candidate.getAttribute('y2')) };
      return distanceBetween(world, nearestPointOnSegment(world, start, end));
    }
    const x = Number(candidate.getAttribute('x'));
    const y = Number(candidate.getAttribute('y'));
    const object = this.room.objects.find((item) => item.id === selection.id);
    const elevation = this.view === 'floor' && object?.wallMount ? wallElevation(this.room, object.wallMount.wallId) : null;
    const angle = elevation ? Math.atan2(elevation.axis.yMeters, elevation.axis.xMeters) : 0;
    const dx = world.xMeters - x;
    const dy = world.yMeters - y;
    const localX = dx * Math.cos(angle) + dy * Math.sin(angle);
    const localY = -dx * Math.sin(angle) + dy * Math.cos(angle);
    const width = Number(candidate.getAttribute('width'));
    const height = Number(candidate.getAttribute('height'));
    return Math.hypot(Math.max(-localX, 0, localX - width), Math.max(-localY, 0, localY - height));
  }

  private handleSelectionPointer(world: Point, target: SVGElement | null): void {
    const selection: EditorSelection = target?.dataset.openingId && (target.dataset.openingType === 'door' || target.dataset.openingType === 'window')
      ? { type: target.dataset.openingType, id: target.dataset.openingId }
      : target?.dataset.wallId ? { type: 'wall', id: target.dataset.wallId }
        : target?.dataset.objectId ? { type: 'object', id: target.dataset.objectId }
          : target?.dataset.roomId ? { type: 'room', id: target.dataset.roomId } : null;
    if (selection && !this.canEditSelection(selection)) return;
    if (target?.dataset.openingId && (target.dataset.openingType === 'door' || target.dataset.openingType === 'window')) {
      this.select({ type: target.dataset.openingType, id: target.dataset.openingId });
      return;
    }
    if (target?.dataset.wallId) {
      this.select({ type: 'wall', id: target.dataset.wallId });
      if (this.selectedWall()?.locked) return;
      this.dragOrigin = world;
      this.dragEndpoint = target.dataset.endpoint === 'start' || target.dataset.endpoint === 'end' ? target.dataset.endpoint : null;
      this.originalRoom = structuredClone(this.room);
      return;
    }
    if (target?.dataset.objectId) {
      this.select({ type: 'object', id: target.dataset.objectId });
      this.dragOrigin = world;
      this.resizingObject = target.dataset.resizeObject === 'true';
      this.originalRoom = structuredClone(this.room);
      return;
    }
    if (target?.dataset.roomId) {
      this.select({ type: 'room', id: target.dataset.roomId });
      return;
    }
    this.selection = null;
    this.onSelection(null);
    this.panOrigin = world;
    this.originalViewBox = { ...this.viewBox };
    this.render();
  }

  private pointerMove(event: PointerEvent): void {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    const world = this.pointerWorld(event);
    this.pointers.set(event.pointerId, { ...pointer, screenX: event.clientX, screenY: event.clientY, world });

    if (this.handlePinchMove()) return;
    if (this.handleObjectDrag(world)) return;
    if (this.handleWallDrag(world)) return;
    this.handlePanMove(world);
  }

  private handlePinchMove(): boolean {
    if (this.pointers.size !== 2 || !this.pinchStartViewBox) return false;
    const [first, second] = [...this.pointers.values()];
    const distance = Math.max(1, Math.hypot(second.screenX - first.screenX, second.screenY - first.screenY));
    const factor = this.pinchDistance / distance;
    this.viewBox.width = this.pinchStartViewBox.width * factor;
    this.viewBox.height = this.pinchStartViewBox.height * factor;
    const midpoint = { xMeters: (first.world.xMeters + second.world.xMeters) / 2, yMeters: (first.world.yMeters + second.world.yMeters) / 2 };
    this.viewBox.x = midpoint.xMeters - this.viewBox.width / 2;
    this.viewBox.y = midpoint.yMeters - this.viewBox.height / 2;
    this.updateViewBox();
    return true;
  }

  private handleObjectDrag(world: Point): boolean {
    if (!this.dragOrigin || this.selection?.type !== 'object' || !this.originalRoom) return false;
    const original = this.originalRoom.objects.find((candidate) => candidate.id === this.selection?.id);
    const object = this.room.objects.find((candidate) => candidate.id === this.selection?.id);
    if (original?.wallMount && object?.wallMount && this.view !== 'floor') {
      const elevation = wallElevation(this.room, this.view);
      const objectElevation = wallElevation(this.room, original.wallMount.wallId);
      if (!elevation || !objectElevation) return true;
      const direction = objectElevation.axis.xMeters * elevation.axis.xMeters + objectElevation.axis.yMeters * elevation.axis.yMeters < 0 ? -1 : 1;
      const deltaX = world.xMeters - this.dragOrigin.xMeters;
      const deltaY = world.yMeters - this.dragOrigin.yMeters;
      if (this.resizingObject) {
        const available = direction > 0 ? objectElevation.length - original.wallMount.offsetMeters : original.wallMount.offsetMeters + original.widthMeters;
        object.widthMeters = Math.max(0.01, Math.min(available, original.widthMeters + deltaX));
        if (direction < 0) object.wallMount.offsetMeters = original.wallMount.offsetMeters - (object.widthMeters - original.widthMeters);
        object.heightMeters = Math.max(0.01, Math.min(roomHeight(this.room) - object.wallMount.elevationMeters, original.heightMeters - deltaY));
      } else {
        const step = (value: number) => this.snap ? Math.round(value * 20) / 20 : value;
        object.wallMount.offsetMeters = Math.max(0, Math.min(objectElevation.length - object.widthMeters, step(original.wallMount.offsetMeters + deltaX * direction)));
        object.wallMount.elevationMeters = Math.max(0, Math.min(roomHeight(this.room) - object.heightMeters, step(original.wallMount.elevationMeters - deltaY)));
      }
      this.syncMountedObjects();
      this.renderGeometryOnly();
      return true;
    }
    if (!original || !object || original.xMeters === undefined || original.yMeters === undefined) return true;
    const moved = this.normalizedPoint({ xMeters: original.xMeters + world.xMeters - this.dragOrigin.xMeters, yMeters: original.yMeters + world.yMeters - this.dragOrigin.yMeters });
    const elevation = original.wallMount ? wallElevation(this.room, original.wallMount.wallId) : null;
    if (elevation && object.wallMount) {
      object.wallMount.offsetMeters = Math.max(0, Math.min(elevation.length - object.widthMeters, (moved.xMeters - elevation.start.xMeters) * elevation.axis.xMeters + (moved.yMeters - elevation.start.yMeters) * elevation.axis.yMeters));
      this.syncMountedObjects();
    } else {
      object.xMeters = moved.xMeters;
      object.yMeters = moved.yMeters;
    }
    this.renderGeometryOnly();
    return true;
  }

  private handleWallDrag(world: Point): boolean {
    if (!this.dragOrigin || this.selection?.type !== 'wall' || !this.originalRoom) return false;
    const source = this.originalRoom.walls.find((wall) => wall.id === this.selection?.id);
    const wall = this.selectedWall();
    if (!source || !wall) return false;
    const delta = { xMeters: world.xMeters - this.dragOrigin.xMeters, yMeters: world.yMeters - this.dragOrigin.yMeters };
    if (this.dragEndpoint) this.moveConnectedEndpoint(source, wall, this.dragEndpoint, delta);
    else this.moveWholeWall(source, wall, delta);
    delete wall.lengthMeters;
    this.syncPolygonFromWalls();
    this.syncMountedObjects();
    this.renderGeometryOnly();
    return true;
  }

  private moveConnectedEndpoint(source: Wall, wall: Wall, endpoint: 'start' | 'end', delta: Point): void {
    const sourcePoint = source[endpoint];
    const movedPoint = { xMeters: sourcePoint.xMeters + delta.xMeters, yMeters: sourcePoint.yMeters + delta.yMeters };
    wall[endpoint] = movedPoint;
    for (const originalNeighbor of this.originalRoom?.walls ?? []) {
      if (originalNeighbor.id === wall.id) continue;
      const currentNeighbor = this.room.walls.find((candidate) => candidate.id === originalNeighbor.id);
      if (!currentNeighbor) continue;
      if (distanceBetween(originalNeighbor.start, sourcePoint) < 0.05) currentNeighbor.start = structuredClone(movedPoint);
      if (distanceBetween(originalNeighbor.end, sourcePoint) < 0.05) currentNeighbor.end = structuredClone(movedPoint);
    }
  }

  private moveWholeWall(source: Wall, wall: Wall, delta: Point): void {
    const connected = (this.originalRoom?.walls ?? []).some((other) => other.id !== source.id && [source.start, source.end].some((point) => distanceBetween(other.start, point) < 0.05 || distanceBetween(other.end, point) < 0.05));
    let move = delta;
    if (connected) {
      // Slide along the wall's normal so connected walls follow and the shape keeps its angles.
      const length = distanceBetween(source.start, source.end) || 1;
      const normal = { xMeters: -(source.end.yMeters - source.start.yMeters) / length, yMeters: (source.end.xMeters - source.start.xMeters) / length };
      const amount = delta.xMeters * normal.xMeters + delta.yMeters * normal.yMeters;
      move = { xMeters: normal.xMeters * amount, yMeters: normal.yMeters * amount };
    }
    this.moveConnectedEndpoint(source, wall, 'start', move);
    this.moveConnectedEndpoint(source, wall, 'end', move);
  }

  private handlePanMove(world: Point): void {
    if (!this.panOrigin || !this.originalViewBox) return;
    this.viewBox.x = this.originalViewBox.x - (world.xMeters - this.panOrigin.xMeters);
    this.viewBox.y = this.originalViewBox.y - (world.yMeters - this.panOrigin.yMeters);
    this.updateViewBox();
  }

  private pointerUp(event: PointerEvent): void {
    this.pointers.delete(event.pointerId);
    if (this.dragOrigin && this.originalRoom) {
      const changed = JSON.stringify(this.room) !== JSON.stringify(this.originalRoom);
      if (changed) {
        this.syncSplitOpenings();
        this.undoStack.push(this.originalRoom);
        this.redoStack = [];
        this.onChange(structuredClone(this.room), true);
      } else if (this.doubleClickSelection) {
        const now = performance.now();
        const sameSelection = this.lastPointerSelection?.type === this.doubleClickSelection.type && this.lastPointerSelection.id === this.doubleClickSelection.id;
        if (sameSelection && now - this.lastPointerUpAt < 450) {
          this.lastPointerUpAt = 0;
          this.lastPointerSelection = null;
          this.lastHandledDoubleClickAt = now;
          this.handleDoubleClick(null, this.doubleClickSelection);
        } else {
          this.lastPointerUpAt = now;
          this.lastPointerSelection = structuredClone(this.doubleClickSelection);
        }
      }
    }
    this.dragOrigin = null;
    this.resizingObject = false;
    this.dragEndpoint = null;
    this.originalRoom = null;
    this.panOrigin = null;
    this.originalViewBox = null;
    if (this.pointers.size < 2) {
      this.pinchDistance = 0;
      this.pinchStartViewBox = null;
    }
    this.render();
  }

  private addWallPoint(world: Point): void {
    const last = this.room.walls[this.room.walls.length - 1];
    const chained = this.wallStart && last && distanceBetween(last.end, this.wallStart) < 1e-9 ? last : null;
    const point = this.constrainRightAngle(this.normalizedPoint(world), chained?.start, this.wallStart);
    if (!this.wallStart) {
      this.wallStart = point;
      this.drawingPoints = [point];
      this.render();
      return;
    }
    if (distanceBetween(this.wallStart, point) < 0.05) return;
    this.beginAction();
    this.room.walls.push({ id: createId(), start: this.wallStart, end: point, thicknessMeters: 0.15 });
    this.wallStart = point;
    this.drawingPoints = [point];
    this.commitAction();
  }

  private constrainRightAngle(point: Point, previous?: Point | null, from?: Point | null): Point {
    if (!this.rightAngles || !from) return point;
    if (!previous) {
      const horizontal = Math.abs(point.xMeters - from.xMeters) >= Math.abs(point.yMeters - from.yMeters);
      return horizontal ? { xMeters: point.xMeters, yMeters: from.yMeters } : { xMeters: from.xMeters, yMeters: point.yMeters };
    }
    return perpendicularPoint(previous, from, point);
  }

  private addObjectPoint(world: Point): void {
    const point = this.view === 'floor' ? this.normalizedPoint(world) : { xMeters: this.snap ? Math.round(world.xMeters * 20) / 20 : world.xMeters, yMeters: this.snap ? Math.round(world.yMeters * 20) / 20 : world.yMeters };
    const elevation = this.view === 'floor' ? null : wallElevation(this.room, this.view);
    if (this.view !== 'floor' && (!elevation || point.xMeters < 0 || point.xMeters > elevation.length || point.yMeters < -roomHeight(this.room) || point.yMeters > 0)) return;
    if (!this.objectStart) {
      this.objectStart = point;
      this.render();
      return;
    }
    const width = Math.abs(point.xMeters - this.objectStart.xMeters);
    const depth = Math.abs(point.yMeters - this.objectStart.yMeters);
    if (width < 0.05 || depth < 0.05) return;
    if (this.view !== 'floor' && (!elevation || Math.min(point.xMeters, this.objectStart.xMeters) < 0 || Math.max(point.xMeters, this.objectStart.xMeters) > elevation.length || Math.min(point.yMeters, this.objectStart.yMeters) < -roomHeight(this.room) || Math.max(point.yMeters, this.objectStart.yMeters) > 0)) return;
    this.beginAction();
    const object: RoomObject = {
      id: createId(),
      name: `Object ${this.room.objects.length + 1}`,
      ...(this.layer === 'technician' || this.layer === 'designer' ? { layer: this.layer } : {}),
      widthMeters: width,
      depthMeters: elevation ? 0.05 : depth,
      heightMeters: elevation ? depth : 1,
      xMeters: Math.min(point.xMeters, this.objectStart.xMeters),
      yMeters: Math.min(point.yMeters, this.objectStart.yMeters),
      ...(elevation ? { wallMount: { wallId: this.view, offsetMeters: Math.min(point.xMeters, this.objectStart.xMeters), elevationMeters: -Math.max(point.yMeters, this.objectStart.yMeters) } } : {}),
    };
    this.room.objects.push(object);
    this.objectStart = null;
    this.selection = { type: 'object', id: object.id };
    this.onSelection(this.selection);
    this.commitAction();
  }

  updateObject(id: string, changes: Partial<Pick<RoomObject, 'name' | 'widthMeters' | 'depthMeters' | 'heightMeters'>>, measurement?: Measurement): boolean {
    const object = this.room.objects.find((candidate) => candidate.id === id);
    if (!object || !this.canEditSelection({ type: 'object', id })) return false;
    const elevation = object.wallMount ? wallElevation(this.room, object.wallMount.wallId) : null;
    if (elevation && ((changes.widthMeters ?? object.widthMeters) > elevation.length || (changes.heightMeters ?? object.heightMeters) > roomHeight(this.room))) return false;
    this.beginAction();
    Object.assign(object, changes);
    if (elevation && object.wallMount) {
      object.wallMount.offsetMeters = Math.min(object.wallMount.offsetMeters, elevation.length - object.widthMeters);
      object.wallMount.elevationMeters = Math.min(object.wallMount.elevationMeters, roomHeight(this.room) - object.heightMeters);
    }
    this.commitAction(measurement);
    return true;
  }

  updateWallMount(id: string, offsetMeters: number, elevationMeters: number): boolean {
    const object = this.room.objects.find((candidate) => candidate.id === id);
    if (!object?.wallMount || !this.canEditSelection({ type: 'object', id })) return false;
    const elevation = wallElevation(this.room, object.wallMount.wallId);
    if (!elevation || !Number.isFinite(offsetMeters) || !Number.isFinite(elevationMeters) || offsetMeters < 0 || elevationMeters < 0 || offsetMeters + object.widthMeters > elevation.length || elevationMeters + object.heightMeters > roomHeight(this.room)) return false;
    this.beginAction();
    object.wallMount.offsetMeters = offsetMeters;
    object.wallMount.elevationMeters = elevationMeters;
    this.commitAction();
    return true;
  }

  detachObjectFromWall(id: string): void {
    const object = this.room.objects.find((candidate) => candidate.id === id);
    if (!object?.wallMount || !this.canEditSelection({ type: 'object', id })) return;
    this.beginAction();
    delete object.wallMount;
    this.selection = null;
    this.commitAction();
    this.onSelection(null);
  }

  private addRoomPoint(world: Point): void {
    const raw = this.normalizedPoint(world);
    if (this.drawingPoints.length >= 3 && distanceBetween(raw, this.drawingPoints[0]) < 0.25) {
      this.finishRoom();
      return;
    }
    const count = this.drawingPoints.length;
    const point = count >= 1 ? this.constrainRightAngle(raw, this.drawingPoints[count - 2], this.drawingPoints[count - 1]) : raw;
    this.drawingPoints.push(point);
    this.render();
  }

  finishRoom(): void {
    if (this.drawingPoints.length < 3) return;
    if (this.rightAngles && this.drawingPoints.length >= 4) {
      // Make the last corner 90° too, so the closing wall is perpendicular to the previous one.
      const points = this.drawingPoints;
      points[points.length - 1] = perpendicularPoint(points[points.length - 3], points[points.length - 2], points[0]);
    }
    const issues = polygonIssues(this.drawingPoints);
    if (issues.length) {
      this.summary.textContent = issues.join(' ');
      return;
    }
    this.beginAction();
    this.room.points = structuredClone(this.drawingPoints);
    this.room.walls = this.drawingPoints.map((point, index) => ({
      id: createId(),
      start: structuredClone(point),
      end: structuredClone(this.drawingPoints[(index + 1) % this.drawingPoints.length]),
      thicknessMeters: 0.15,
    }));
    this.room.doors = [];
    this.room.windows = [];
    this.drawingPoints = [];
    this.selection = { type: 'room', id: this.room.id };
    this.commitAction();
  }

  private addOpeningAt(type: EditorTool, wall: Wall, world: Point): void {
    const point = nearestPointOnSegment(world, wall.start, wall.end);
    const wallLength = distanceBetween(wall.start, wall.end);
    const width = type === 'door' ? Math.min(0.9, wallLength * 0.7) : Math.min(1.2, wallLength * 0.7);
    const fromStart = distanceBetween(wall.start, point);
    const minimumSide = 0.05;
    const offset = Math.max(minimumSide, Math.min(wallLength - width - minimumSide, fromStart - width / 2));
    const opening = { id: createId(), wallId: wall.id, offsetMeters: offset, widthMeters: width };
    const existing = [...this.room.doors, ...this.room.windows].filter((candidate) => !candidate.rightWallId && candidate.wallId === wall.id);
    if (!this.canSplitWallForOpenings(wall, [...existing, opening])) return;
    this.beginAction();
    this.splitWallForOpenings(wall, [...existing, opening]);
    if (type === 'door') this.room.doors.push(opening as Door);
    else this.room.windows.push(opening as Window);
    this.commitAction();
  }

  private canSplitWallForOpenings(wall: Wall, openings: Array<Door | Window>): boolean {
    const length = distanceBetween(wall.start, wall.end);
    const sorted = [...openings].sort((left, right) => left.offsetMeters - right.offsetMeters);
    let cursor = 0;
    for (const opening of sorted) {
      if (opening.offsetMeters - cursor <= 0.05 || opening.widthMeters <= 0) return false;
      cursor = opening.offsetMeters + opening.widthMeters;
      if (cursor > length + 1e-9) return false;
    }
    return length - cursor > 0.05;
  }

  private splitWallForOpenings(wall: Wall, openings: Array<Door | Window>): void {
    const sorted = [...openings].sort((left, right) => left.offsetMeters - right.offsetMeters);
    const originalStart = structuredClone(wall.start);
    const originalEnd = structuredClone(wall.end);
    const angle = Math.atan2(originalEnd.yMeters - originalStart.yMeters, originalEnd.xMeters - originalStart.xMeters);
    const pointAt = (distance: number) => ({
      xMeters: originalStart.xMeters + Math.cos(angle) * distance,
      yMeters: originalStart.yMeters + Math.sin(angle) * distance,
    });
    const segments: Wall[] = [];
    let cursor = 0;
    for (let index = 0; index <= sorted.length; index += 1) {
      const end = index === sorted.length ? distanceBetween(originalStart, originalEnd) : sorted[index].offsetMeters;
      const segment = index === 0 ? wall : { ...structuredClone(wall), id: createId() };
      segment.start = pointAt(cursor);
      segment.end = pointAt(end);
      delete segment.lengthMeters;
      segments.push(segment);
      if (index < sorted.length) cursor = sorted[index].offsetMeters + sorted[index].widthMeters;
    }
    sorted.forEach((opening, index) => {
      opening.wallId = segments[index].id;
      opening.rightWallId = segments[index + 1].id;
    });
    const wallIndex = this.room.walls.indexOf(wall);
    this.room.walls.splice(wallIndex, 1, ...segments);
    const migratedIds = new Set(sorted.map((opening) => opening.id));
    const lastSegmentId = segments[segments.length - 1].id;
    for (const otherOpening of [...this.room.doors, ...this.room.windows]) {
      if (migratedIds.has(otherOpening.id)) continue;
      if (otherOpening.wallId === wall.id) otherOpening.wallId = lastSegmentId;
    }
  }

  private resizeSplitOpening(leftWall: Wall, rightWall: Wall, totalLength: number, offsetMeters: number, widthMeters: number): void {
    const oldEnd = structuredClone(rightWall.end);
    const angle = Math.atan2(rightWall.end.yMeters - leftWall.start.yMeters, rightWall.end.xMeters - leftWall.start.xMeters);
    const pointAt = (distance: number) => ({
      xMeters: leftWall.start.xMeters + Math.cos(angle) * distance,
      yMeters: leftWall.start.yMeters + Math.sin(angle) * distance,
    });
    leftWall.end = pointAt(offsetMeters);
    rightWall.start = pointAt(offsetMeters + widthMeters);
    rightWall.end = pointAt(totalLength);
    delete leftWall.lengthMeters;
    delete rightWall.lengthMeters;
    this.moveConnectedPoint(oldEnd, rightWall.end, new Set([leftWall.id, rightWall.id]));
    this.room.points = this.room.points.map((point) => distanceBetween(point, oldEnd) < 0.05 ? structuredClone(rightWall.end) : point);
  }

  private removeOpening(kind: OpeningKind, id: string): void {
    const openings = kind === 'door' ? this.room.doors : this.room.windows;
    const opening = openings.find((candidate) => candidate.id === id);
    if (!opening) return;
    const leftWall = this.room.walls.find((wall) => wall.id === opening.wallId);
    const rightWall = opening.rightWallId ? this.room.walls.find((wall) => wall.id === opening.rightWallId) : undefined;
    if (leftWall && rightWall) {
      leftWall.end = structuredClone(rightWall.end);
      delete leftWall.lengthMeters;
      this.room.walls = this.room.walls.filter((wall) => wall.id !== rightWall.id);
      for (const otherOpening of [...this.room.doors, ...this.room.windows]) {
        if (otherOpening.id === id) continue;
        if (otherOpening.wallId === rightWall.id) otherOpening.wallId = leftWall.id;
        if (otherOpening.rightWallId === rightWall.id) otherOpening.rightWallId = leftWall.id;
      }
    }
    if (kind === 'door') this.room.doors = this.room.doors.filter((candidate) => candidate.id !== id);
    else this.room.windows = this.room.windows.filter((candidate) => candidate.id !== id);
  }

  private moveConnectedPoint(from: Point, to: Point, excludedWallIds: Set<string>): void {
    for (const wall of this.room.walls) {
      if (excludedWallIds.has(wall.id)) continue;
      if (distanceBetween(wall.start, from) < 0.05) wall.start = structuredClone(to);
      if (distanceBetween(wall.end, from) < 0.05) wall.end = structuredClone(to);
    }
  }

  private select(selection: EditorSelection): void {
    this.selection = selection;
    this.onSelection(selection);
    this.render();
  }

  private selectedWall(): Wall | null {
    if (this.selection?.type !== 'wall') return null;
    if (!this.canEditSelection(this.selection)) return null;
    return this.room.walls.find((wall) => wall.id === this.selection?.id) ?? null;
  }

  private beginAction(): void {
    this.undoStack.push(structuredClone(this.room));
    this.redoStack = [];
  }

  private commitAction(measurement?: Measurement): void {
    this.syncSplitOpenings();
    this.syncMountedObjects();
    if (measurement) this.room.measurements.push(measurement);
    this.onChange(structuredClone(this.room), true);
    this.render();
  }

  private syncMountedObjects(): void {
    for (const object of this.room.objects) {
      if (!object.wallMount) continue;
      const elevation = wallElevation(this.room, object.wallMount.wallId);
      if (!elevation) {
        delete object.wallMount;
        continue;
      }
      const point = pointOnWall(elevation, object.wallMount.offsetMeters);
      object.xMeters = point.xMeters;
      object.yMeters = point.yMeters;
    }
  }

  private syncSplitOpenings(): void {
    for (const opening of [...this.room.doors, ...this.room.windows]) {
      if (!opening.rightWallId) continue;
      const leftWall = this.room.walls.find((wall) => wall.id === opening.wallId);
      const rightWall = this.room.walls.find((wall) => wall.id === opening.rightWallId);
      if (!leftWall || !rightWall) continue;
      opening.offsetMeters = distanceBetween(leftWall.start, leftWall.end);
      opening.widthMeters = distanceBetween(leftWall.end, rightWall.start);
    }
  }

  /** Moves the wall's end point and keeps the room connected; a perpendicular next wall is translated so rectangles shrink instead of tearing. */
  private resizeWall(wall: Wall, lengthMeters: number): void {
    const walls = this.room.walls;
    const oldEnd = structuredClone(wall.end);
    const angle = Math.atan2(wall.end.yMeters - wall.start.yMeters, wall.end.xMeters - wall.start.xMeters);
    const newEnd = {
      xMeters: wall.start.xMeters + Math.cos(angle) * lengthMeters,
      yMeters: wall.start.yMeters + Math.sin(angle) * lengthMeters,
    };
    const delta = { xMeters: newEnd.xMeters - oldEnd.xMeters, yMeters: newEnd.yMeters - oldEnd.yMeters };
    wall.end = newEnd;
    wall.lengthMeters = lengthMeters;
    const index = walls.indexOf(wall);
    const next = walls[(index + 1) % walls.length];
    const following = walls[(index + 2) % walls.length];
    const closed = walls.length >= 3 && walls.every((candidate, i) => distanceBetween(i === index ? oldEnd : candidate.end, walls[(i + 1) % walls.length].start) < 0.05);
    if (closed && next !== wall) {
      const cross = (a: Wall) => (a.end.xMeters - a.start.xMeters) * (wall.end.yMeters - wall.start.yMeters) - (a.end.yMeters - a.start.yMeters) * (wall.end.xMeters - wall.start.xMeters);
      const dot = (a: Wall, b: Wall) => (a.end.xMeters - a.start.xMeters) * (b.end.xMeters - b.start.xMeters) + (a.end.yMeters - a.start.yMeters) * (b.end.yMeters - b.start.yMeters);
      const perpendicular = Math.abs(dot(next, wall)) < 1e-6 * Math.max(1, distanceBetween(next.start, next.end) * distanceBetween(wall.start, wall.end));
      const parallel = following !== wall && following !== next && Math.abs(cross(following)) < 1e-6 * Math.max(1, distanceBetween(following.start, following.end) * distanceBetween(wall.start, wall.end));
      next.start = structuredClone(newEnd);
      if (perpendicular && parallel) {
        next.end = { xMeters: next.end.xMeters + delta.xMeters, yMeters: next.end.yMeters + delta.yMeters };
        following.start = structuredClone(next.end);
      }
      delete next.lengthMeters;
      if (perpendicular && parallel) delete following.lengthMeters;
    }
    this.syncPolygonFromWalls();
  }

  private syncPolygonFromWalls(): void {
    if (this.room.points.length !== this.room.walls.length) return;
    this.room.points = this.room.walls.map((wall) => structuredClone(wall.start));
  }

  private normalizedPoint(point: Point): Point {
    if (!this.snap) return point;
    const endpoints = this.room.walls.flatMap((wall) => [wall.start, wall.end]);
    return snapPoint(point, 0.1, [...endpoints, ...this.room.points, ...(this.drawingPoints[0] ? [this.drawingPoints[0]] : [])]);
  }

  private render(): void {
    this.renderViewControls();
    this.renderGeometryOnly();
    this.renderTools();
    const area = roomArea(this.room);
    const selected = this.selectedWall();
    const issues = polygonIssues(this.room.points).filter(() => this.room.points.length > 0);
    this.summary.textContent = this.summaryText(area, selected, issues);
  }

  private summaryText(area: number, selected: Wall | null, issues: string[]): string {
    if (this.view !== 'floor') return this.tool === 'object' ? 'Choose two corners on the wall.' : 'Select an object to move or resize it.';
    if (selected) return `${formatLength(distanceBetween(selected.start, selected.end), this.units)} selected`;
    if (area > 0) {
      const issueText = issues.length ? ` · ${issues[0]}` : '';
      return `${area.toFixed(2)} m² plan${issueText}`;
    }
    return toolHint(this.tool, this.drawingPoints.length);
  }

  private renderViewControls(): void {
    this.viewControls.replaceChildren();
    const select = document.createElement('select');
    select.className = 'room-selector';
    select.setAttribute('aria-label', 'Editor view');
    select.append(new Option('Floor plan', 'floor'));
    const included = new Set<string>();
    for (const wall of this.room.walls) {
      if (included.has(wall.id)) continue;
      const elevation = wallElevation(this.room, wall.id);
      if (!elevation) continue;
      elevation.wallIds.forEach((id) => included.add(id));
      select.append(new Option(`Wall ${select.options.length} (${formatLength(elevation.length, this.units)})`, wall.id));
    }
    select.value = this.view;
    select.addEventListener('change', () => {
      this.view = select.value;
      this.tool = 'select';
      this.objectStart = null;
      this.wallStart = null;
      this.drawingPoints = [];
      this.selection = null;
      this.onSelection(null);
      this.svg.setAttribute('aria-label', this.view === 'floor' ? `Editable floor plan for ${this.room.name}` : `Editable wall elevation for ${this.room.name}`);
      this.fitDrawing();
    });
    this.viewControls.append(select);
    if (this.view === 'floor' || this.layer !== 'technician') return;
    const elevation = wallElevation(this.room, this.view);
    if (!elevation) return;
    const objects = this.room.objects.filter((object) => (object.layer ?? 'designer') === 'technician' && (!object.wallMount || !elevation.wallIds.includes(object.wallMount.wallId)));
    const picker = document.createElement('select');
    picker.className = 'room-selector';
    picker.setAttribute('aria-label', 'Object to place on wall');
    picker.append(new Option('Choose object', ''));
    for (const object of objects) picker.append(new Option(object.name, object.id));
    const place = this.actionButton('Place', 'Place object on wall', () => {
      const object = this.room.objects.find((candidate) => candidate.id === picker.value);
      if (!object || !this.canEditSelection({ type: 'object', id: object.id })) return;
      this.beginAction();
      object.wallMount = { wallId: this.view, offsetMeters: Math.max(0, (elevation.length - object.widthMeters) / 2), elevationMeters: Math.max(0, Math.min(0.3, roomHeight(this.room) - object.heightMeters)) };
      this.selection = { type: 'object', id: object.id };
      this.commitAction();
      this.onSelection(this.selection);
    });
    place.disabled = objects.length === 0;
    this.viewControls.append(picker, place);
  }

  private renderWallElevation(): void {
    const elevation = wallElevation(this.room, this.view);
    if (!elevation) return;
    const height = roomHeight(this.room);
    const wall = svgElement('rect', 'editor-elevation-wall');
    wall.setAttribute('x', '0');
    wall.setAttribute('y', String(-height));
    wall.setAttribute('width', String(elevation.length));
    wall.setAttribute('height', String(height));
    this.svg.append(wall);
    for (const [kind, openings] of [['door', this.room.doors], ['window', this.room.windows]] as const) {
      for (const opening of openings) {
        if (!elevation.wallIds.includes(opening.wallId)) continue;
        const segment = this.room.walls.find((candidate) => candidate.id === opening.wallId);
        if (!segment) continue;
        const right = opening.rightWallId ? this.room.walls.find((candidate) => candidate.id === opening.rightWallId) : undefined;
        const segmentLength = distanceBetween(segment.start, segment.end);
        if (!segmentLength) continue;
        const point = right ? segment.end : { xMeters: segment.start.xMeters + (segment.end.xMeters - segment.start.xMeters) * opening.offsetMeters / segmentLength, yMeters: segment.start.yMeters + (segment.end.yMeters - segment.start.yMeters) * opening.offsetMeters / segmentLength };
        const offset = (point.xMeters - elevation.start.xMeters) * elevation.axis.xMeters + (point.yMeters - elevation.start.yMeters) * elevation.axis.yMeters;
        const segmentDirection = (segment.end.xMeters - segment.start.xMeters) * elevation.axis.xMeters + (segment.end.yMeters - segment.start.yMeters) * elevation.axis.yMeters;
        const openingHeight = Math.min(height, opening.heightMeters ?? (kind === 'door' ? DEFAULT_DOOR_HEIGHT_METERS : DEFAULT_WINDOW_HEIGHT_METERS));
        const sill = kind === 'window' ? Math.min(0.9, Math.max(0, height - openingHeight)) : 0;
        const rect = svgElement('rect', `editor-elevation-opening editor-elevation-${kind}`);
        rect.setAttribute('x', String(offset - (segmentDirection < 0 ? opening.widthMeters : 0)));
        rect.setAttribute('y', String(-sill - openingHeight));
        rect.setAttribute('width', String(opening.widthMeters));
        rect.setAttribute('height', String(openingHeight));
        this.svg.append(rect);
      }
    }
    for (const object of this.room.objects) {
      if (!object.wallMount || !elevation.wallIds.includes(object.wallMount.wallId)) continue;
      const objectElevation = wallElevation(this.room, object.wallMount.wallId);
      if (!objectElevation) continue;
      const point = pointOnWall(objectElevation, object.wallMount.offsetMeters);
      const direction = objectElevation.axis.xMeters * elevation.axis.xMeters + objectElevation.axis.yMeters * elevation.axis.yMeters;
      const offset = (point.xMeters - elevation.start.xMeters) * elevation.axis.xMeters + (point.yMeters - elevation.start.yMeters) * elevation.axis.yMeters - (direction < 0 ? object.widthMeters : 0);
      const top = -object.wallMount.elevationMeters - object.heightMeters;
      const editable = this.canEditSelection({ type: 'object', id: object.id });
      if (editable) {
        const hit = svgElement('rect', 'editor-elevation-hit');
        const minimum = Math.max(0.16, this.viewBox.width * 36 / Math.max(this.svg.clientWidth, 300));
        const hitWidth = Math.max(object.widthMeters, minimum);
        const hitHeight = Math.max(object.heightMeters, minimum);
        hit.setAttribute('x', String(offset + (object.widthMeters - hitWidth) / 2));
        hit.setAttribute('y', String(top + (object.heightMeters - hitHeight) / 2));
        hit.setAttribute('width', String(hitWidth));
        hit.setAttribute('height', String(hitHeight));
        hit.dataset.objectId = object.id;
        this.svg.append(hit);
      }
      const rect = svgElement('rect', 'editor-object editor-elevation-object');
      rect.setAttribute('x', String(offset));
      rect.setAttribute('y', String(top));
      rect.setAttribute('width', String(object.widthMeters));
      rect.setAttribute('height', String(object.heightMeters));
      rect.dataset.objectId = object.id;
      if (!editable) rect.style.pointerEvents = 'none';
      if (this.selection?.type === 'object' && this.selection.id === object.id) rect.classList.add('is-selected');
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = object.name;
      rect.append(title);
      this.svg.append(rect);
      if (editable && this.selection?.type === 'object' && this.selection.id === object.id) {
        const handle = this.pointMarker({ xMeters: offset + object.widthMeters + 0.1, yMeters: top - 0.1 });
        handle.dataset.objectId = object.id;
        handle.dataset.resizeObject = 'true';
        this.svg.append(handle);
      }
    }
    if (this.objectStart) this.svg.append(this.pointMarker(this.objectStart));
  }

  private renderGeometryOnly(): void {
    this.updateViewBox();
    this.svg.replaceChildren();
    if (this.showGrid) this.svg.append(this.buildGrid());
    if (this.view !== 'floor') {
      this.renderWallElevation();
      return;
    }
    if (this.room.points.length >= 3) {
      const polygon = svgElement('polygon', 'editor-room');
      polygon.setAttribute('points', this.room.points.map((point) => `${point.xMeters},${point.yMeters}`).join(' '));
      polygon.dataset.roomId = this.room.id;
      if (this.layer && this.layer !== 'builder') polygon.style.pointerEvents = 'none';
      if (this.selection?.type === 'room') polygon.classList.add('is-selected');
      this.svg.append(polygon);
    }
    for (const wall of this.room.walls) this.svg.append(...this.buildWall(wall));
    const objects = [...this.room.objects].sort((first, second) => Number(this.canEditSelection({ type: 'object', id: first.id })) - Number(this.canEditSelection({ type: 'object', id: second.id })));
    for (const object of objects) this.svg.append(...this.buildObject(object));
    for (const door of this.room.doors) this.svg.append(this.buildOpening(door, 'door'));
    for (const window of this.room.windows) this.svg.append(this.buildOpening(window, 'window'));
    if (this.drawingPoints.length) {
      const points = document.createDocumentFragment();
      for (const point of this.drawingPoints) points.append(this.pointMarker(point));
      if (this.drawingPoints.length > 1) {
        const path = svgElement('polyline', 'editor-draft');
        path.setAttribute('points', this.drawingPoints.map((point) => `${point.xMeters},${point.yMeters}`).join(' '));
        points.prepend(path);
      }
      this.svg.append(points);
    }
    if (this.wallStart) this.svg.append(this.pointMarker(this.wallStart));
    if (this.objectStart) this.svg.append(this.pointMarker(this.objectStart));
  }

  private buildWall(wall: Wall): SVGElement[] {
    const hit = svgElement('line', 'editor-wall-hit');
    const line = svgElement('line', 'editor-wall');
    for (const item of [hit, line]) {
      item.setAttribute('x1', String(wall.start.xMeters));
      item.setAttribute('y1', String(wall.start.yMeters));
      item.setAttribute('x2', String(wall.end.xMeters));
      item.setAttribute('y2', String(wall.end.yMeters));
      item.dataset.wallId = wall.id;
      if (this.layer && this.layer !== 'builder') item.style.pointerEvents = 'none';
    }
    const dimension = svgElement('text', 'editor-dimension');
    dimension.setAttribute('x', String((wall.start.xMeters + wall.end.xMeters) / 2));
    dimension.setAttribute('y', String((wall.start.yMeters + wall.end.yMeters) / 2 - 0.18));
    dimension.textContent = formatLength(distanceBetween(wall.start, wall.end), this.units);
    if (this.layer && this.layer !== 'builder') dimension.style.pointerEvents = 'none';
    if (this.selection?.type === 'wall' && this.selection.id === wall.id) {
      line.classList.add('is-selected');
      const startMarker = this.pointMarker(wall.start);
      const endMarker = this.pointMarker(wall.end);
      for (const [marker, endpoint] of [[startMarker, 'start'], [endMarker, 'end']] as const) {
        marker.dataset.wallId = wall.id;
        marker.dataset.endpoint = endpoint;
      }
      return [hit, line, dimension, startMarker, endMarker];
    }
    return [hit, line, dimension];
  }

  private buildObject(object: RoomObject): SVGElement[] {
    if (object.xMeters === undefined || object.yMeters === undefined) return [];
    const rect = svgElement('rect', 'editor-object');
    rect.setAttribute('x', String(object.xMeters));
    rect.setAttribute('y', String(object.yMeters));
    rect.setAttribute('width', String(object.widthMeters));
    rect.setAttribute('height', String(object.depthMeters));
    rect.dataset.objectId = object.id;
    const elevation = object.wallMount ? wallElevation(this.room, object.wallMount.wallId) : null;
    if (elevation) rect.setAttribute('transform', `rotate(${Math.atan2(elevation.axis.yMeters, elevation.axis.xMeters) * 180 / Math.PI} ${object.xMeters} ${object.yMeters})`);
    if (this.selection?.type === 'object' && this.selection.id === object.id) rect.classList.add('is-selected');
    const width = svgElement('text', 'editor-dimension');
    width.setAttribute('x', String(object.xMeters + object.widthMeters / 2));
    width.setAttribute('y', String(object.yMeters - 0.12));
    width.textContent = formatLength(object.widthMeters, this.units);
    const depth = svgElement('text', 'editor-dimension');
    depth.setAttribute('x', String(object.xMeters + object.widthMeters + 0.12));
    depth.setAttribute('y', String(object.yMeters + object.depthMeters / 2));
    depth.style.textAnchor = 'start';
    depth.textContent = formatLength(object.depthMeters, this.units);
    const label = svgElement('text', 'editor-dimension');
    label.setAttribute('x', String(object.xMeters + object.widthMeters / 2));
    label.setAttribute('y', String(object.yMeters + object.depthMeters / 2 + 0.1));
    label.textContent = object.name;
    for (const item of [width, depth, label]) item.dataset.objectId = object.id;
    if (!this.canEditSelection({ type: 'object', id: object.id })) {
      for (const item of [rect, width, depth, label]) item.style.pointerEvents = 'none';
    }
    return [rect, width, depth, label];
  }

  private buildOpening(opening: Door | Window, type: 'door' | 'window'): SVGElement {
    const leftWall = this.room.walls.find((candidate) => candidate.id === opening.wallId);
    if (!leftWall) return svgElement('g', 'editor-opening-missing');
    const rightWall = opening.rightWallId ? this.room.walls.find((candidate) => candidate.id === opening.rightWallId) : undefined;
    const wallEnd = rightWall?.end ?? leftWall.end;
    const wallLength = distanceBetween(leftWall.start, wallEnd);
    const angle = Math.atan2(wallEnd.yMeters - leftWall.start.yMeters, wallEnd.xMeters - leftWall.start.xMeters);
    const offset = rightWall ? distanceBetween(leftWall.start, leftWall.end) : opening.offsetMeters;
    const start = rightWall ? structuredClone(leftWall.end) : { xMeters: leftWall.start.xMeters + Math.cos(angle) * offset, yMeters: leftWall.start.yMeters + Math.sin(angle) * offset };
    const end = rightWall ? structuredClone(rightWall.start) : { xMeters: start.xMeters + Math.cos(angle) * Math.min(opening.widthMeters, wallLength), yMeters: start.yMeters + Math.sin(angle) * Math.min(opening.widthMeters, wallLength) };
    const line = svgElement('line', `editor-opening editor-${type}`);
    line.setAttribute('x1', String(start.xMeters));
    line.setAttribute('y1', String(start.yMeters));
    line.setAttribute('x2', String(end.xMeters));
    line.setAttribute('y2', String(end.yMeters));
    line.dataset.openingId = opening.id;
    line.dataset.openingType = type;
    if (this.layer && this.layer !== 'builder') line.style.pointerEvents = 'none';
    if (this.selection?.id === opening.id && this.selection.type === type) line.classList.add('is-selected');
    return line;
  }

  private buildGrid(): SVGElement {
    const group = svgElement('g', 'editor-grid');
    const spacing = 1;
    for (let x = Math.floor(this.viewBox.x); x <= this.viewBox.x + this.viewBox.width; x += spacing) {
      group.append(gridLine(x, this.viewBox.y, x, this.viewBox.y + this.viewBox.height, 'minor'));
    }
    for (let y = Math.floor(this.viewBox.y); y <= this.viewBox.y + this.viewBox.height; y += spacing) {
      group.append(gridLine(this.viewBox.x, y, this.viewBox.x + this.viewBox.width, y, 'minor'));
    }
    return group;
  }

  private pointMarker(point: Point): SVGElement {
    const marker = svgElement('circle', 'editor-point');
    marker.setAttribute('cx', String(point.xMeters));
    marker.setAttribute('cy', String(point.yMeters));
    marker.setAttribute('r', String(Math.max(0.08, this.viewBox.width / 150)));
    return marker;
  }

  private renderTools(): void {
    this.controls.replaceChildren();
    const tools: Array<[EditorTool, string]> = [['select', 'Select'], ['wall', 'Wall'], ['room', 'Room'], ['door', 'Door'], ['window', 'Window'], ['object', 'Object'], ['measure', 'Measure']];
    for (const [tool, label] of tools) {
      if (!this.allowedTools().includes(tool)) continue;
      const button = this.actionButton(label, `${label} tool`, () => this.setTool(tool), this.tool === tool);
      this.controls.append(button);
    }
    const undo = this.actionButton('Undo', 'Undo last edit', () => this.undo());
    const redo = this.actionButton('Redo', 'Redo last edit', () => this.redo());
    const paste = this.actionButton('Paste', 'Paste copied wall', () => this.pasteSelection());
    undo.disabled = this.undoStack.length === 0;
    redo.disabled = this.redoStack.length === 0;
    paste.disabled = !this.canPaste();
    this.controls.append(undo, redo);
    if (!this.layer || this.layer === 'builder') this.controls.append(paste);
    if (this.tool === 'room' && this.drawingPoints.length >= 3) {
      this.controls.append(this.actionButton('Finish room', 'Complete room outline', () => this.finishRoom()));
    }
  }

  private allowedTools(): EditorTool[] {
    if (this.view !== 'floor') return this.layer === 'technician' || !this.layer ? ['select', 'object', 'measure'] : ['select', 'measure'];
    if (!this.layer) return ['select', 'wall', 'room', 'door', 'window', 'object', 'measure'];
    if (this.layer === 'builder') return ['select', 'wall', 'room', 'door', 'window', 'measure'];
    return ['select', 'object', 'measure'];
  }

  private canEditSelection(selection: NonNullable<EditorSelection>): boolean {
    if (!this.layer) return true;
    if (selection.type !== 'object') return this.layer === 'builder';
    const object = this.room.objects.find((candidate) => candidate.id === selection.id);
    return !!object && (object.layer ?? 'designer') === this.layer;
  }

  private pointerWorld(event: PointerEvent): Point {
    const svgPoint = this.svg.createSVGPoint();
    svgPoint.x = event.clientX;
    svgPoint.y = event.clientY;
    const matrix = this.svg.getScreenCTM();
    const transformed = matrix ? svgPoint.matrixTransform(matrix.inverse()) : svgPoint;
    return { xMeters: transformed.x, yMeters: transformed.y };
  }

  private updateViewBox(): void {
    this.svg.setAttribute('viewBox', `${this.viewBox.x} ${this.viewBox.y} ${this.viewBox.width} ${this.viewBox.height}`);
  }

  private zoomAtCenter(factor: number): void {
    const center = { x: this.viewBox.x + this.viewBox.width / 2, y: this.viewBox.y + this.viewBox.height / 2 };
    this.viewBox.width /= factor;
    this.viewBox.height /= factor;
    this.viewBox.x = center.x - this.viewBox.width / 2;
    this.viewBox.y = center.y - this.viewBox.height / 2;
    this.updateViewBox();
  }

  private fitDrawing(): void {
    if (this.view !== 'floor') {
      const elevation = wallElevation(this.room, this.view);
      if (elevation) {
        this.viewBox = { x: -0.3, y: -roomHeight(this.room) - 0.3, width: elevation.length + 0.6, height: roomHeight(this.room) + 0.6 };
        this.render();
        return;
      }
      this.view = 'floor';
    }
    const objectCorners = this.room.objects.flatMap((object) => object.xMeters === undefined || object.yMeters === undefined ? [] : [
      { xMeters: object.xMeters, yMeters: object.yMeters },
      { xMeters: object.xMeters + object.widthMeters, yMeters: object.yMeters + object.depthMeters },
    ]);
    const points = [...this.room.points, ...this.room.walls.flatMap((wall) => [wall.start, wall.end]), ...objectCorners];
    if (!points.length) {
      this.viewBox = { x: -1, y: -1, width: 14, height: 11 };
    } else {
      const minX = Math.min(...points.map((point) => point.xMeters));
      const maxX = Math.max(...points.map((point) => point.xMeters));
      const minY = Math.min(...points.map((point) => point.yMeters));
      const maxY = Math.max(...points.map((point) => point.yMeters));
      const width = Math.max(2, maxX - minX + 2);
      const height = Math.max(2, maxY - minY + 2);
      this.viewBox = { x: minX - 1, y: minY - 1, width, height };
    }
    this.render();
  }

  private fitSelection(): void {
    const wall = this.selectedWall();
    if (!wall) return this.fitDrawing();
    const width = Math.max(2, Math.abs(wall.end.xMeters - wall.start.xMeters) + 2);
    const height = Math.max(2, Math.abs(wall.end.yMeters - wall.start.yMeters) + 2);
    this.viewBox = {
      x: Math.min(wall.start.xMeters, wall.end.xMeters) - 1,
      y: Math.min(wall.start.yMeters, wall.end.yMeters) - 1,
      width,
      height,
    };
    this.updateViewBox();
  }
}

function svgElement<K extends keyof SVGElementTagNameMap>(tag: K, className: string): SVGElementTagNameMap[K] {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  element.classList.add(...className.split(' '));
  return element;
}

function gridLine(x1: number, y1: number, x2: number, y2: number, className: string): SVGLineElement {
  const line = svgElement('line', `grid-line ${className}`);
  line.setAttribute('x1', String(x1));
  line.setAttribute('y1', String(y1));
  line.setAttribute('x2', String(x2));
  line.setAttribute('y2', String(y2));
  return line;
}

function rotatePoint(point: Point, center: Point): Point {
  const x = point.xMeters - center.xMeters;
  const y = point.yMeters - center.yMeters;
  return { xMeters: center.xMeters - y, yMeters: center.yMeters + x };
}

function toolHint(tool: EditorTool, roomPointCount: number): string {
  return {
    select: 'Tap an object to select. Drag empty space to pan.',
    wall: 'Tap start and end points to draw walls.',
    room: roomPointCount ? `${roomPointCount} room vertices · tap the first point or Finish room` : 'Tap each room corner, then tap the first point.',
    door: 'Tap a wall to place a door.',
    window: 'Tap a wall to place a window.',
    object: 'Tap two opposite corners to draw an object.',
    measure: 'Tap a wall or object to enter its measured size.',
  }[tool];
}
