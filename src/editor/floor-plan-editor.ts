import { createId, type Door, type Point, type Room, type Wall, type Window } from '../domain/models';
import { cornerAngleDegrees, distanceBetween, formatLength, nearestPointOnSegment, perpendicularPoint, polygonIssues, roomArea, setCornerAngle, snapPoint } from '../geometry';

export type EditorTool = 'select' | 'wall' | 'room' | 'door' | 'window' | 'measure';
export type EditorSelection = { type: 'wall' | 'room'; id: string } | null;

export interface FloorPlanEditorOptions {
  room: Room;
  units: 'metric' | 'imperial';
  onChange(room: Room, completed: boolean): void;
  onSelection(selection: EditorSelection): void;
  onMeasure?(wall: Wall): void;
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
  private readonly onChange: FloorPlanEditorOptions['onChange'];
  private readonly onSelection: FloorPlanEditorOptions['onSelection'];
  private readonly onMeasure: FloorPlanEditorOptions['onMeasure'];
  private readonly onOpening: FloorPlanEditorOptions['onOpening'];
  private readonly svg: SVGSVGElement;
  private readonly controls: HTMLElement;
  private readonly summary: HTMLElement;
  private tool: EditorTool = 'select';
  private selection: EditorSelection = null;
  private drawingPoints: Point[] = [];
  private wallStart: Point | null = null;
  private readonly pointers = new Map<number, PointerSnapshot>();
  private dragOrigin: Point | null = null;
  private dragEndpoint: 'start' | 'end' | null = null;
  private originalRoom: Room | null = null;
  private panOrigin: Point | null = null;
  private originalViewBox: ViewBox | null = null;
  private pinchDistance = 0;
  private pinchStartViewBox: ViewBox | null = null;
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
    this.onChange = options.onChange;
    this.onSelection = options.onSelection;
    this.onMeasure = options.onMeasure;
    this.onOpening = options.onOpening;
    this.element = document.createElement('div');
    this.element.className = 'floor-editor';

    this.controls = document.createElement('div');
    this.controls.className = 'editor-tool-row';
    this.controls.setAttribute('aria-label', 'Floor plan tools');
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.classList.add('editor-svg');
    this.svg.setAttribute('role', 'application');
    this.svg.setAttribute('aria-label', `Editable floor plan for ${this.room.name}`);
    this.summary = document.createElement('div');
    this.summary.className = 'editor-summary';
    this.summary.setAttribute('aria-live', 'polite');

    this.element.append(this.buildUtilityRow(), this.svg, this.summary, this.controls);
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
    this.tool = tool;
    this.wallStart = null;
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
    if (!this.selection) return;
    this.beginAction();
    if (this.selection.type === 'wall') {
      this.room.walls = this.room.walls.filter((wall) => wall.id !== this.selection?.id);
      this.room.doors = this.room.doors.filter((door) => door.wallId !== this.selection?.id);
      this.room.windows = this.room.windows.filter((window) => window.wallId !== this.selection?.id);
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

  setWallLength(lengthMeters: number): void {
    const wall = this.selectedWall();
    if (!wall || lengthMeters <= 0) return;
    this.beginAction();
    const angle = Math.atan2(wall.end.yMeters - wall.start.yMeters, wall.end.xMeters - wall.start.xMeters);
    wall.end = {
      xMeters: wall.start.xMeters + Math.cos(angle) * lengthMeters,
      yMeters: wall.start.yMeters + Math.sin(angle) * lengthMeters,
    };
    wall.lengthMeters = lengthMeters;
    this.syncPolygonFromWalls();
    this.commitAction();
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
    const wall = opening ? this.room.walls.find((candidate) => candidate.id === opening.wallId) : undefined;
    return opening && wall ? structuredClone({ opening, wall }) : null;
  }

  updateOpening(kind: OpeningKind, id: string, wallLengthMeters: number, offsetMeters: number, widthMeters: number): boolean {
    const opening = (kind === 'door' ? this.room.doors : this.room.windows).find((candidate) => candidate.id === id);
    const wall = opening ? this.room.walls.find((candidate) => candidate.id === opening.wallId) : undefined;
    if (!opening || !wall || wallLengthMeters <= 0 || widthMeters <= 0 || offsetMeters < 0) return false;
    if (offsetMeters + widthMeters > wallLengthMeters + 1e-9) return false;
    this.beginAction();
    if (Math.abs(wallLengthMeters - distanceBetween(wall.start, wall.end)) > 1e-9) {
      const angle = Math.atan2(wall.end.yMeters - wall.start.yMeters, wall.end.xMeters - wall.start.xMeters);
      wall.end = { xMeters: wall.start.xMeters + Math.cos(angle) * wallLengthMeters, yMeters: wall.start.yMeters + Math.sin(angle) * wallLengthMeters };
      wall.lengthMeters = wallLengthMeters;
      this.syncPolygonFromWalls();
    }
    opening.offsetMeters = offsetMeters;
    opening.widthMeters = widthMeters;
    this.commitAction();
    return true;
  }

  getWallOpenings(): Array<{ kind: OpeningKind; opening: Door | Window }> {
    const wall = this.selectedWall();
    if (!wall) return [];
    return [
      ...this.room.doors.filter((door) => door.wallId === wall.id).map((opening) => ({ kind: 'door' as const, opening: structuredClone(opening) })),
      ...this.room.windows.filter((window) => window.wallId === wall.id).map((opening) => ({ kind: 'window' as const, opening: structuredClone(opening) })),
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
    if (length < widthMeters) return;
    this.beginAction();
    const opening = { id: createId(), wallId: wall.id, offsetMeters: (length - widthMeters) / 2, widthMeters };
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
      this.fitSelection();
    });
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

    const target = (event.target as Element).closest<SVGElement>('[data-wall-id], [data-room-id]');
    if (this.handleToolPointer(world, target)) return;
    this.handleSelectionPointer(world, target);
  }

  private handleToolPointer(world: Point, target: SVGElement | null): boolean {
    if (this.tool === 'wall') this.addWallPoint(world);
    else if (this.tool === 'room') this.addRoomPoint(world);
    else if (this.tool === 'door' || this.tool === 'window') this.handleOpeningPointer(world, target);
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
    const wall = this.room.walls.find((candidate) => candidate.id === target?.dataset.wallId);
    if (!wall) return;
    this.select({ type: 'wall', id: wall.id });
    this.onMeasure?.(structuredClone(wall));
  }

  private handleSelectionPointer(world: Point, target: SVGElement | null): void {
    if (target?.dataset.wallId) {
      this.select({ type: 'wall', id: target.dataset.wallId });
      if (this.selectedWall()?.locked) return;
      this.dragOrigin = world;
      this.dragEndpoint = target.dataset.endpoint === 'start' || target.dataset.endpoint === 'end' ? target.dataset.endpoint : null;
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
    wall.start = { xMeters: source.start.xMeters + delta.xMeters, yMeters: source.start.yMeters + delta.yMeters };
    wall.end = { xMeters: source.end.xMeters + delta.xMeters, yMeters: source.end.yMeters + delta.yMeters };
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
        this.undoStack.push(this.originalRoom);
        this.redoStack = [];
        this.onChange(structuredClone(this.room), true);
      }
    }
    this.dragOrigin = null;
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
    if (!this.rightAngles || !previous || !from) return point;
    return perpendicularPoint(previous, from, point);
  }

  private addRoomPoint(world: Point): void {
    const raw = this.normalizedPoint(world);
    if (this.drawingPoints.length >= 3 && distanceBetween(raw, this.drawingPoints[0]) < 0.25) {
      this.finishRoom();
      return;
    }
    const count = this.drawingPoints.length;
    const point = count >= 2 ? this.constrainRightAngle(raw, this.drawingPoints[count - 2], this.drawingPoints[count - 1]) : raw;
    this.drawingPoints.push(point);
    this.render();
  }

  finishRoom(): void {
    if (this.drawingPoints.length < 3) return;
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
    this.beginAction();
    const point = nearestPointOnSegment(world, wall.start, wall.end);
    const wallLength = distanceBetween(wall.start, wall.end);
    const width = type === 'door' ? Math.min(0.9, wallLength * 0.7) : Math.min(1.2, wallLength * 0.7);
    const fromStart = distanceBetween(wall.start, point);
    const offset = Math.max(0, Math.min(wallLength - width, fromStart - width / 2));
    const opening = { id: createId(), wallId: wall.id, offsetMeters: offset, widthMeters: width };
    if (type === 'door') this.room.doors.push(opening as Door);
    else this.room.windows.push(opening as Window);
    this.commitAction();
  }

  private select(selection: EditorSelection): void {
    this.selection = selection;
    this.onSelection(selection);
    this.render();
  }

  private selectedWall(): Wall | null {
    if (this.selection?.type !== 'wall') return null;
    return this.room.walls.find((wall) => wall.id === this.selection?.id) ?? null;
  }

  private beginAction(): void {
    this.undoStack.push(structuredClone(this.room));
    this.redoStack = [];
  }

  private commitAction(): void {
    this.onChange(structuredClone(this.room), true);
    this.render();
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
    this.renderGeometryOnly();
    this.renderTools();
    const area = roomArea(this.room);
    const selected = this.selectedWall();
    const issues = polygonIssues(this.room.points).filter(() => this.room.points.length > 0);
    this.summary.textContent = this.summaryText(area, selected, issues);
  }

  private summaryText(area: number, selected: Wall | null, issues: string[]): string {
    if (selected) return `${formatLength(distanceBetween(selected.start, selected.end), this.units)} selected`;
    if (area > 0) {
      const issueText = issues.length ? ` · ${issues[0]}` : '';
      return `${area.toFixed(2)} m² plan${issueText}`;
    }
    return toolHint(this.tool, this.drawingPoints.length);
  }

  private renderGeometryOnly(): void {
    this.updateViewBox();
    this.svg.replaceChildren();
    if (this.showGrid) this.svg.append(this.buildGrid());
    if (this.room.points.length >= 3) {
      const polygon = svgElement('polygon', 'editor-room');
      polygon.setAttribute('points', this.room.points.map((point) => `${point.xMeters},${point.yMeters}`).join(' '));
      polygon.dataset.roomId = this.room.id;
      if (this.selection?.type === 'room') polygon.classList.add('is-selected');
      this.svg.append(polygon);
    }
    for (const wall of this.room.walls) this.svg.append(...this.buildWall(wall));
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
    }
    const dimension = svgElement('text', 'editor-dimension');
    dimension.setAttribute('x', String((wall.start.xMeters + wall.end.xMeters) / 2));
    dimension.setAttribute('y', String((wall.start.yMeters + wall.end.yMeters) / 2 - 0.18));
    dimension.textContent = formatLength(distanceBetween(wall.start, wall.end), this.units);
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

  private buildOpening(opening: Door | Window, type: 'door' | 'window'): SVGElement {
    const wall = this.room.walls.find((candidate) => candidate.id === opening.wallId);
    if (!wall) return svgElement('g', 'editor-opening-missing');
    const wallLength = distanceBetween(wall.start, wall.end);
    const angle = Math.atan2(wall.end.yMeters - wall.start.yMeters, wall.end.xMeters - wall.start.xMeters);
    const start = { xMeters: wall.start.xMeters + Math.cos(angle) * opening.offsetMeters, yMeters: wall.start.yMeters + Math.sin(angle) * opening.offsetMeters };
    const end = { xMeters: start.xMeters + Math.cos(angle) * Math.min(opening.widthMeters, wallLength), yMeters: start.yMeters + Math.sin(angle) * Math.min(opening.widthMeters, wallLength) };
    const line = svgElement('line', `editor-opening editor-${type}`);
    line.setAttribute('x1', String(start.xMeters));
    line.setAttribute('y1', String(start.yMeters));
    line.setAttribute('x2', String(end.xMeters));
    line.setAttribute('y2', String(end.yMeters));
    line.dataset.wallId = wall.id;
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
    const tools: Array<[EditorTool, string]> = [['select', 'Select'], ['wall', 'Wall'], ['room', 'Room'], ['door', 'Door'], ['window', 'Window'], ['measure', 'Measure']];
    for (const [tool, label] of tools) {
      const button = this.actionButton(label, `${label} tool`, () => this.setTool(tool), this.tool === tool);
      this.controls.append(button);
    }
    const undo = this.actionButton('Undo', 'Undo last edit', () => this.undo());
    const redo = this.actionButton('Redo', 'Redo last edit', () => this.redo());
    const paste = this.actionButton('Paste', 'Paste copied wall', () => this.pasteSelection());
    undo.disabled = this.undoStack.length === 0;
    redo.disabled = this.redoStack.length === 0;
    paste.disabled = !this.canPaste();
    this.controls.append(undo, redo, paste);
    if (this.tool === 'room' && this.drawingPoints.length >= 3) {
      this.controls.append(this.actionButton('Finish room', 'Complete room outline', () => this.finishRoom()));
    }
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
    const points = [...this.room.points, ...this.room.walls.flatMap((wall) => [wall.start, wall.end])];
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
    measure: 'Tap a wall to enter its measured length.',
  }[tool];
}
