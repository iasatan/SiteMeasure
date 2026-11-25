import { describe, expect, it } from 'vitest';
import { createRoom } from '../src/domain/models';
import { FloorPlanEditor } from '../src/editor/floor-plan-editor';

interface EditorInternals {
  element: HTMLElement;
  room: { walls: Array<{ id: string; start: { xMeters: number; yMeters: number }; end: { xMeters: number; yMeters: number } }>; doors: Array<{ id: string; wallId: string; rightWallId?: string; offsetMeters: number; widthMeters: number }> };
  selection: { type: 'wall' | 'door' | 'window' | 'room' | 'object'; id: string } | null;
  dragOrigin: { xMeters: number; yMeters: number };
  originalRoom: unknown;
  setWallLength(lengthMeters: number): void;
  addDoorToSelectedWall(widthMeters?: number): void;
  deleteSelection(): void;
  handleWallDrag(point: { xMeters: number; yMeters: number }): void;
  handleSelectionPointer(point: { xMeters: number; yMeters: number }, target: SVGElement | null): void;
  nearestSelectionTarget(point: { xMeters: number; yMeters: number }, target: SVGElement | null): SVGElement | null;
}

function rectangleEditor(): EditorInternals {
  const room = createRoom();
  const points = [[0, 0], [4, 0], [4, 4], [0, 4]].map(([xMeters, yMeters]) => ({ xMeters, yMeters }));
  room.points = points;
  room.walls = points.map((start, index) => ({ id: `w${index}`, start: { ...start }, end: { ...points[(index + 1) % 4] } })) as typeof room.walls;
  return new FloorPlanEditor({ room, units: 'metric', onChange: () => {}, onSelection: () => {}, onMeasure: () => {}, onOpening: () => {} } as never) as unknown as EditorInternals;
}

const loop = (editor: EditorInternals) => editor.room.walls.map((wall) => [wall.start.xMeters, wall.start.yMeters, wall.end.xMeters, wall.end.yMeters].map((value) => Math.round(value * 1000) / 1000));

describe('floor plan editor', () => {
  it('rotates a free-standing object around its center and supports undo and redo', () => {
    const room = createRoom();
    room.objects = [{ id: 'cabinet', name: 'Cabinet', widthMeters: 2, depthMeters: 1, heightMeters: 1, xMeters: 1, yMeters: 2 }];
    const changes: ReturnType<typeof createRoom>[] = [];
    const editor = new FloorPlanEditor({ room, layer: 'designer', units: 'metric', onChange: (changed) => changes.push(changed), onSelection: () => {} });
    const internals = editor as unknown as EditorInternals;
    internals.selection = { type: 'object', id: 'cabinet' };
    editor.rotateSelection();
    expect(editor.getRoom().objects[0]).toMatchObject({ xMeters: 2.5, yMeters: 1.5, rotationRadians: Math.PI / 2 });
    expect(changes.at(-1)?.objects[0].rotationRadians).toBe(Math.PI / 2);
    editor.undo();
    expect(editor.getRoom().objects[0]).toMatchObject({ xMeters: 1, yMeters: 2 });
    expect(editor.getRoom().objects[0].rotationRadians).toBeUndefined();
    editor.redo();
    expect(editor.getRoom().objects[0].rotationRadians).toBe(Math.PI / 2);
  });

  it('does not rotate wall-mounted objects', () => {
    const room = createRoom();
    room.objects = [{ id: 'socket', name: 'Socket', widthMeters: 1, depthMeters: 0.5, heightMeters: 1, xMeters: 1, yMeters: 2, wallMount: { wallId: 'wall', offsetMeters: 1, elevationMeters: 1 } }];
    const editor = new FloorPlanEditor({ room, layer: 'designer', units: 'metric', onChange: () => {}, onSelection: () => {} });
    (editor as unknown as EditorInternals).selection = { type: 'object', id: 'socket' };
    editor.rotateSelection();
    expect(editor.getRoom().objects[0]).toEqual(room.objects[0]);
  });

  it('projects objects between the wall and the room center onto wall elevations', () => {
    const room = createRoom();
    room.points = [[0, 0], [4, 0], [4, 4], [0, 4]].map(([xMeters, yMeters]) => ({ xMeters, yMeters }));
    room.walls = room.points.map((start, index) => ({ id: `wall${index}`, start, end: room.points[(index + 1) % 4], thicknessMeters: 0.15 }));
    room.objects = [
      { id: 'cabinet', name: 'Cabinet', widthMeters: 1, depthMeters: 0.5, heightMeters: 1.2, xMeters: 1, yMeters: 0.5 },
      { id: 'behind', name: 'Behind', widthMeters: 1, depthMeters: 0.5, heightMeters: 1, xMeters: 1, yMeters: 3 },
      { id: 'outside', name: 'Outside', widthMeters: 1, depthMeters: 0.5, heightMeters: 1, xMeters: 5, yMeters: 0.5 },
    ];
    const editor = new FloorPlanEditor({ room, layer: 'designer', units: 'metric', onChange: () => {}, onSelection: () => {} });
    const view = editor.element.querySelector<HTMLSelectElement>('[aria-label="Editor view"]')!;
    view.value = 'wall0';
    view.dispatchEvent(new Event('change'));
    const cabinet = editor.element.querySelector<SVGElement>('.editor-elevation-object[data-object-id="cabinet"]')!;
    expect(cabinet.getAttribute('x')).toBe('1');
    expect(cabinet.getAttribute('y')).toBe('-1.2');
    expect(cabinet.getAttribute('width')).toBe('1');
    expect(editor.element.querySelector('.editor-elevation-object[data-object-id="behind"]')).toBeNull();
    expect(editor.element.querySelector('.editor-elevation-object[data-object-id="outside"]')).toBeNull();
    const internals = editor as unknown as EditorInternals & { handleObjectDrag(point: { xMeters: number; yMeters: number }): void };
    internals.handleSelectionPointer({ xMeters: 1.5, yMeters: -0.5 }, cabinet);
    internals.handleObjectDrag({ xMeters: 2, yMeters: -1 });
    expect(editor.getRoom().objects[0]).toMatchObject({ xMeters: 1.5, yMeters: 0.5, elevationMeters: 0.5 });
    expect(editor.element.querySelector('[data-resize-object="true"]')).not.toBeNull();
  });

  it('projects adjacent wall mounts and clipped footprints in depth order', () => {
    const room = createRoom();
    room.points = [[0, 0], [4, 0], [4, 4], [0, 4]].map(([xMeters, yMeters]) => ({ xMeters, yMeters }));
    room.walls = room.points.map((start, index) => ({ id: `wall${index}`, start, end: room.points[(index + 1) % 4], thicknessMeters: 0.15 }));
    room.objects = [
      { id: 'foreground', name: 'Chair', widthMeters: 1, depthMeters: 0.5, heightMeters: 1, xMeters: 1, yMeters: 1.5 },
      { id: 'background', name: 'Table', widthMeters: 1, depthMeters: 0.5, heightMeters: 0.8, xMeters: 1, yMeters: 0.5 },
      { id: 'side', name: 'Socket', layer: 'technician', widthMeters: 0.1, depthMeters: 0.1, heightMeters: 0.1, wallMount: { wallId: 'wall3', offsetMeters: 3, elevationMeters: 1 } },
      { id: 'partial', name: 'Shelf', widthMeters: 1, depthMeters: 0.5, heightMeters: 1, xMeters: -0.5, yMeters: 0.5 },
    ];
    const editor = new FloorPlanEditor({ room, layer: 'designer', units: 'metric', onChange: () => {}, onSelection: () => {} });
    const view = editor.element.querySelector<HTMLSelectElement>('[aria-label="Editor view"]')!;
    view.value = 'wall0';
    view.dispatchEvent(new Event('change'));
    const side = editor.element.querySelector<SVGElement>('.editor-elevation-object[data-object-id="side"]')!;
    expect(side.getAttribute('y')).toBe('-1.1');
    expect(side.style.pointerEvents).toBe('none');
    expect(editor.element.querySelector('.editor-elevation-object[data-object-id="partial"]')?.getAttribute('width')).toBe('0.5');
    const rendered = [...editor.element.querySelectorAll<SVGElement>('.editor-elevation-object')].map((object) => object.dataset.objectId);
    expect(rendered.indexOf('background')).toBeLessThan(rendered.indexOf('foreground'));
    view.value = 'wall2';
    view.dispatchEvent(new Event('change'));
    expect(editor.element.querySelector('.editor-elevation-object[data-object-id="foreground"]')).not.toBeNull();
    expect(editor.element.querySelector('.editor-elevation-object[data-object-id="background"]')).toBeNull();
  });

  it('moves and resizes projected objects using wall coordinates and supports undo', () => {
    const room = createRoom();
    room.points = [[0, 0], [4, 0], [4, 4], [0, 4]].map(([xMeters, yMeters]) => ({ xMeters, yMeters }));
    room.walls = room.points.map((start, index) => ({ id: `wall${index}`, start, end: room.points[(index + 1) % 4], thicknessMeters: 0.15 }));
    room.objects = [{ id: 'cabinet', name: 'Cabinet', widthMeters: 1, depthMeters: 0.5, heightMeters: 1, xMeters: 1, yMeters: 0.5 }];
    const changes: ReturnType<typeof createRoom>[] = [];
    const editor = new FloorPlanEditor({ room, layer: 'designer', units: 'metric', onChange: (changed) => changes.push(changed), onSelection: () => {} });
    const internals = editor as unknown as EditorInternals & { handleObjectDrag(point: { xMeters: number; yMeters: number }): void; pointerUp(event: { pointerId: number }): void };
    const view = editor.element.querySelector<HTMLSelectElement>('[aria-label="Editor view"]')!;
    view.value = 'wall0';
    view.dispatchEvent(new Event('change'));
    internals.handleSelectionPointer({ xMeters: 1.5, yMeters: -0.5 }, editor.element.querySelector<SVGElement>('.editor-elevation-object')!);
    internals.handleObjectDrag({ xMeters: 2, yMeters: -0.8 });
    internals.pointerUp({ pointerId: 1 });
    expect(changes.at(-1)?.objects[0]).toMatchObject({ xMeters: 1.5, yMeters: 0.5, elevationMeters: 0.3 });
    const handle = editor.element.querySelector<SVGElement>('[data-resize-object="true"]')!;
    internals.handleSelectionPointer({ xMeters: 2.6, yMeters: -1.4 }, handle);
    internals.handleObjectDrag({ xMeters: 3.1, yMeters: -1.7 });
    internals.pointerUp({ pointerId: 1 });
    expect(editor.getRoom().objects[0]).toMatchObject({ widthMeters: 1.5, depthMeters: 0.5, elevationMeters: 0.3 });
    expect(editor.getRoom().objects[0].heightMeters).toBeCloseTo(1.3);
    editor.undo();
    expect(editor.getRoom().objects[0]).toMatchObject({ widthMeters: 1, heightMeters: 1, elevationMeters: 0.3 });
    editor.redo();
    expect(editor.getRoom().objects[0].widthMeters).toBe(1.5);
  });

  it('edits an adjacent wall mount and restores it when undone', () => {
    const room = createRoom();
    room.points = [[0, 0], [4, 0], [4, 4], [0, 4]].map(([xMeters, yMeters]) => ({ xMeters, yMeters }));
    room.walls = room.points.map((start, index) => ({ id: `wall${index}`, start, end: room.points[(index + 1) % 4], thicknessMeters: 0.15 }));
    room.objects = [{ id: 'socket', name: 'Socket', layer: 'technician', widthMeters: 0.1, depthMeters: 0.1, heightMeters: 0.1, wallMount: { wallId: 'wall3', offsetMeters: 3, elevationMeters: 1 } }];
    const editor = new FloorPlanEditor({ room, layer: 'technician', units: 'metric', onChange: () => {}, onSelection: () => {} });
    const internals = editor as unknown as EditorInternals & { handleObjectDrag(point: { xMeters: number; yMeters: number }): void; pointerUp(event: { pointerId: number }): void };
    const view = editor.element.querySelector<HTMLSelectElement>('[aria-label="Editor view"]')!;
    view.value = 'wall0';
    view.dispatchEvent(new Event('change'));
    internals.handleSelectionPointer({ xMeters: 0.05, yMeters: -1 }, editor.element.querySelector<SVGElement>('.editor-elevation-object')!);
    expect(editor.element.querySelector('[data-resize-object="true"]')).not.toBeNull();
    internals.handleObjectDrag({ xMeters: 0.05, yMeters: -1.2 });
    expect(editor.getRoom().objects[0].wallMount?.elevationMeters).toBe(1.2);
    internals.handleObjectDrag({ xMeters: 0.55, yMeters: -1.2 });
    const moved = editor.getRoom().objects[0];
    expect(moved.wallMount).toBeUndefined();
    expect(moved.xMeters).toBeCloseTo(0.5);
    expect(moved.yMeters).toBeCloseTo(1);
    expect(moved.rotationRadians).toBeCloseTo(-Math.PI / 2);
    expect(moved.elevationMeters).toBeCloseTo(1.2);
    internals.pointerUp({ pointerId: 1 });
    editor.undo();
    expect(editor.getRoom().objects[0].wallMount).toEqual({ wallId: 'wall3', offsetMeters: 3, elevationMeters: 1 });
  });

  it('resizes the correct floor dimension on perpendicular and reversed walls', () => {
    const room = createRoom();
    room.points = [[0, 0], [4, 0], [4, 4], [0, 4]].map(([xMeters, yMeters]) => ({ xMeters, yMeters }));
    room.walls = room.points.map((start, index) => ({ id: `wall${index}`, start, end: room.points[(index + 1) % 4], thicknessMeters: 0.15 }));
    room.objects = [{ id: 'cabinet', name: 'Cabinet', widthMeters: 1, depthMeters: 0.5, heightMeters: 1, xMeters: 3, yMeters: 2.5 }];
    const editor = new FloorPlanEditor({ room, layer: 'designer', units: 'metric', onChange: () => {}, onSelection: () => {} });
    const internals = editor as unknown as EditorInternals & { handleObjectDrag(point: { xMeters: number; yMeters: number }): void; pointerUp(event: { pointerId: number }): void };
    const view = editor.element.querySelector<HTMLSelectElement>('[aria-label="Editor view"]')!;
    view.value = 'wall1';
    view.dispatchEvent(new Event('change'));
    internals.handleSelectionPointer({ xMeters: 2.7, yMeters: -0.5 }, editor.element.querySelector<SVGElement>('.editor-elevation-object')!);
    internals.handleSelectionPointer({ xMeters: 3.1, yMeters: -1.1 }, editor.element.querySelector<SVGElement>('[data-resize-object="true"]')!);
    internals.handleObjectDrag({ xMeters: 3.6, yMeters: -1.1 });
    internals.pointerUp({ pointerId: 1 });
    expect(editor.getRoom().objects[0]).toMatchObject({ widthMeters: 1, depthMeters: 1, xMeters: 3, yMeters: 2.5 });
    view.value = 'wall2';
    view.dispatchEvent(new Event('change'));
    internals.handleSelectionPointer({ xMeters: 0.5, yMeters: -0.5 }, editor.element.querySelector<SVGElement>('.editor-elevation-object')!);
    internals.handleSelectionPointer({ xMeters: 1.1, yMeters: -1.1 }, editor.element.querySelector<SVGElement>('[data-resize-object="true"]')!);
    internals.handleObjectDrag({ xMeters: 1.6, yMeters: -1.1 });
    internals.pointerUp({ pointerId: 1 });
    expect(editor.getRoom().objects[0]).toMatchObject({ widthMeters: 1.5, depthMeters: 1, xMeters: 2.5, yMeters: 2.5 });
  });

  it('marks small objects without drawing labels over their footprint', () => {
    const room = createRoom();
    room.objects = [{ id: 'socket', name: 'Socket', layer: 'technician', widthMeters: 0.09, depthMeters: 0.09, heightMeters: 0.09, xMeters: 1, yMeters: 2 }];
    const editor = new FloorPlanEditor({ room, layer: 'technician', units: 'metric', onChange: () => {}, onSelection: () => {} });
    const marker = editor.element.querySelector<SVGElement>('.editor-object-marker[data-object-id="socket"]')!;
    const object = editor.element.querySelector<SVGElement>('.editor-object[data-object-id="socket"]')!;
    expect(marker.getAttribute('x1')).toBe('1.045');
    expect(marker.getAttribute('y1')).toBe('2.045');
    expect(object.querySelector('title')?.textContent).toBe('Socket');
    expect(marker.querySelector('title')?.textContent).toBe('Socket');
    expect(editor.element.querySelector('text[data-object-id="socket"]')).toBeNull();
    const internals = editor as unknown as EditorInternals;
    internals.handleSelectionPointer({ xMeters: 1.045, yMeters: 2.045 }, marker);
    expect(internals.selection).toEqual({ type: 'object', id: 'socket' });
    expect(editor.element.querySelector('.editor-object-marker.is-selected')).not.toBeNull();
  });

  it('applies device measurements to selected walls, openings and objects', () => {
    const editor = rectangleEditor() as EditorInternals & { applySelectedMeasurement(measurement: { id: string; targetType: 'wall' | 'other'; targetId: string; valueMeters: number; capturedAt: string; source: 'bluetooth' }): boolean; getRoom(): ReturnType<typeof createRoom> };
    const measurement = (targetId: string, valueMeters: number) => ({ id: targetId, targetType: targetId === 'w0' ? 'wall' as const : 'other' as const, targetId, valueMeters, capturedAt: '2026-01-01T00:00:00Z', source: 'bluetooth' as const });
    editor.selection = { type: 'wall', id: 'w0' };
    expect(editor.applySelectedMeasurement(measurement('w0', 3))).toBe(true);
    expect(loop(editor)[0]).toEqual([0, 0, 3, 0]);
    editor.addDoorToSelectedWall(1);
    const door = editor.getRoom().doors[0];
    editor.selection = { type: 'door', id: door.id };
    expect(editor.applySelectedMeasurement(measurement(door.id, 0.8))).toBe(true);
    expect(editor.getRoom().doors[0].widthMeters).toBeCloseTo(0.8);
    expect(editor.applySelectedMeasurement(measurement(door.id, 4))).toBe(false);
    expect(editor.getRoom().measurements).toHaveLength(2);
  });

  it('picks the nearest editable geometry within a screen-sized tolerance', () => {
    const room = createRoom();
    room.walls = [
      { id: 'upper', start: { xMeters: 0, yMeters: 0 }, end: { xMeters: 4, yMeters: 0 }, thicknessMeters: 0.15 },
      { id: 'lower', start: { xMeters: 0, yMeters: 0.3 }, end: { xMeters: 4, yMeters: 0.3 }, thicknessMeters: 0.15 },
    ];
    room.objects = [{ id: 'chair', name: 'Chair', widthMeters: 0.2, depthMeters: 0.2, heightMeters: 1, xMeters: 2, yMeters: 1 }];
    const editor = new FloorPlanEditor({ room, units: 'metric', onChange: () => {}, onSelection: () => {} });
    const internals = editor as unknown as EditorInternals;
    const upperHit = editor.element.querySelector<SVGElement>('.editor-wall-hit[data-wall-id="upper"]')!;
    expect(internals.nearestSelectionTarget({ xMeters: 1, yMeters: 0.25 }, upperHit)?.dataset.wallId).toBe('lower');
    expect(internals.nearestSelectionTarget({ xMeters: 2.25, yMeters: 1.1 }, null)?.dataset.objectId).toBe('chair');
    expect(internals.nearestSelectionTarget({ xMeters: 10, yMeters: 10 }, null)).toBeNull();

    const designer = new FloorPlanEditor({ room, layer: 'designer', units: 'metric', onChange: () => {}, onSelection: () => {} }) as unknown as EditorInternals;
    expect(designer.nearestSelectionTarget({ xMeters: 1, yMeters: 0.01 }, null)).toBeNull();
  });

  it('picks openings, rotated objects, and elevation objects without stealing handles', () => {
    const room = createRoom();
    room.walls = [{ id: 'wall', start: { xMeters: 0, yMeters: 0 }, end: { xMeters: 0, yMeters: 4 }, thicknessMeters: 0.15 }];
    room.doors = [{ id: 'door', wallId: 'wall', offsetMeters: 1, widthMeters: 0.9 }];
    room.objects = [{ id: 'socket', name: 'Socket', layer: 'technician', widthMeters: 0.3, depthMeters: 0.1, heightMeters: 0.2, xMeters: 0, yMeters: 2, wallMount: { wallId: 'wall', offsetMeters: 2, elevationMeters: 1 } }];
    const editor = new FloorPlanEditor({ room, units: 'metric', onChange: () => {}, onSelection: () => {} });
    const internals = editor as unknown as EditorInternals;
    expect(editor.element.querySelector('.editor-object-marker')?.getAttribute('transform')).toBe(editor.element.querySelector('.editor-object')?.getAttribute('transform'));
    expect(internals.nearestSelectionTarget({ xMeters: 0.05, yMeters: 1.5 }, null)?.dataset.openingId).toBe('door');
    expect(internals.nearestSelectionTarget({ xMeters: -0.05, yMeters: 2.2 }, null)?.dataset.objectId).toBe('socket');
    internals.handleSelectionPointer({ xMeters: 0, yMeters: 0 }, editor.element.querySelector<SVGElement>('.editor-wall[data-wall-id="wall"]')!);
    const handle = editor.element.querySelector<SVGElement>('[data-endpoint="start"]')!;
    expect(internals.nearestSelectionTarget({ xMeters: 0, yMeters: 0 }, handle)).toBe(handle);

    const view = editor.element.querySelector<HTMLSelectElement>('[aria-label="Editor view"]')!;
    view.value = 'wall';
    view.dispatchEvent(new Event('change'));
    expect(internals.nearestSelectionTarget({ xMeters: 2.35, yMeters: -1.1 }, null)?.dataset.objectId).toBe('socket');
  });

  it('selects and starts dragging the closest wall from a pointer event', () => {
    const editor = rectangleEditor();
    const internals = editor as EditorInternals & { pointerWorld(): { xMeters: number; yMeters: number }; pointerDown(event: Partial<PointerEvent>): void };
    internals.pointerWorld = () => ({ xMeters: 2, yMeters: 0.1 });
    const svg = editor.element.querySelector('svg')!;
    internals.pointerDown({ pointerId: 1, clientX: 0, clientY: 0, target: svg, preventDefault: () => {} });
    expect(editor.selection).toEqual({ type: 'wall', id: 'w0' });
    expect(editor.dragOrigin).toEqual({ xMeters: 2, yMeters: 0.1 });
  });

  it('places, moves, resizes and restores an object on a wall', () => {
    const room = createRoom();
    room.walls = [{ id: 'wall', start: { xMeters: 1, yMeters: 2 }, end: { xMeters: 1, yMeters: 6 }, thicknessMeters: 0.15 }];
    room.objects = [{ id: 'socket', name: 'Socket', layer: 'technician', widthMeters: 0.1, depthMeters: 0.05, heightMeters: 0.1, xMeters: 2, yMeters: 3 }];
    const editor = new FloorPlanEditor({ room, layer: 'technician', units: 'metric', onChange: () => {}, onSelection: () => {} });
    const select = editor.element.querySelector<HTMLSelectElement>('[aria-label="Editor view"]')!;
    select.value = 'wall';
    select.dispatchEvent(new Event('change'));
    const picker = editor.element.querySelector<HTMLSelectElement>('[aria-label="Object to place on wall"]')!;
    picker.value = 'socket';
    editor.element.querySelector<HTMLButtonElement>('[aria-label="Place object on wall"]')!.click();
    expect(editor.getRoom().objects[0].wallMount).toEqual({ wallId: 'wall', offsetMeters: 1.95, elevationMeters: 0.3 });
    expect(editor.updateWallMount('socket', 1, 1.2)).toBe(true);
    expect(editor.getRoom().objects[0]).toMatchObject({ xMeters: 1, yMeters: 3, wallMount: { offsetMeters: 1, elevationMeters: 1.2 } });
    expect(editor.updateWallMount('socket', 4, 1)).toBe(false);
    expect(editor.updateObject('socket', { widthMeters: 5 })).toBe(false);

    const internals = editor as unknown as EditorInternals & { handleObjectDrag(point: { xMeters: number; yMeters: number }): void; pointerUp(event: { pointerId: number }): void };
    const target = editor.element.querySelector<SVGElement>('[data-object-id="socket"]')!;
    internals.handleSelectionPointer({ xMeters: 1, yMeters: -1.2 }, target);
    internals.handleObjectDrag({ xMeters: 2, yMeters: -1.7 });
    internals.pointerUp({ pointerId: 1 });
    expect(editor.getRoom().objects[0].wallMount).toEqual({ wallId: 'wall', offsetMeters: 2, elevationMeters: 1.7 });
    const handle = editor.element.querySelector<SVGElement>('[data-resize-object="true"]')!;
    internals.handleSelectionPointer({ xMeters: 2.1, yMeters: -1.8 }, handle);
    internals.handleObjectDrag({ xMeters: 2.6, yMeters: -2.2 });
    internals.pointerUp({ pointerId: 1 });
    expect(editor.getRoom().objects[0].widthMeters).toBeCloseTo(0.6);
    expect(editor.getRoom().objects[0].heightMeters).toBeCloseTo(0.5);
    editor.undo();
    expect(editor.getRoom().objects[0].widthMeters).toBeCloseTo(0.1);
    editor.redo();
    const restored = new FloorPlanEditor({ room: editor.getRoom(), layer: 'technician', units: 'metric', onChange: () => {}, onSelection: () => {} });
    const restoredView = restored.element.querySelector<HTMLSelectElement>('[aria-label="Editor view"]')!;
    restoredView.value = 'wall';
    restoredView.dispatchEvent(new Event('change'));
    expect(restored.element.querySelector('[data-object-id="socket"]')).not.toBeNull();
    expect(restored.getRoom().objects[0].heightMeters).toBeCloseTo(0.5);
    const designer = new FloorPlanEditor({ room: editor.getRoom(), layer: 'designer', units: 'metric', onChange: () => {}, onSelection: () => {} });
    const designerView = designer.element.querySelector<HTMLSelectElement>('[aria-label="Editor view"]')!;
    designerView.value = 'wall';
    designerView.dispatchEvent(new Event('change'));
    const socket = designer.element.querySelector<SVGElement>('.editor-elevation-object')!;
    expect(socket.style.pointerEvents).toBe('none');
    expect(designer.updateWallMount('socket', 0, 0)).toBe(false);
  });

  it('draws a wall-mounted object in elevation coordinates', () => {
    const room = createRoom();
    room.walls = [{ id: 'wall', start: { xMeters: 0, yMeters: 0 }, end: { xMeters: 4, yMeters: 0 }, thicknessMeters: 0.15 }];
    const editor = new FloorPlanEditor({ room, layer: 'technician', units: 'metric', onChange: () => {}, onSelection: () => {} });
    const select = editor.element.querySelector<HTMLSelectElement>('[aria-label="Editor view"]')!;
    select.value = 'wall';
    select.dispatchEvent(new Event('change'));
    editor.setTool('object');
    const internals = editor as unknown as { addObjectPoint(point: { xMeters: number; yMeters: number }): void };
    internals.addObjectPoint({ xMeters: -1, yMeters: -2 });
    internals.addObjectPoint({ xMeters: 1, yMeters: -2 });
    internals.addObjectPoint({ xMeters: 2, yMeters: -1 });
    expect(editor.getRoom().objects[0]).toMatchObject({ layer: 'technician', widthMeters: 1, heightMeters: 1, depthMeters: 0.05, xMeters: 1, yMeters: 0, wallMount: { wallId: 'wall', offsetMeters: 1, elevationMeters: 1 } });
  });

  it('moves objects correctly on a reversed connected wall segment', () => {
    const room = createRoom();
    room.walls = [
      { id: 'first', start: { xMeters: 0, yMeters: 0 }, end: { xMeters: 2, yMeters: 0 }, thicknessMeters: 0.15 },
      { id: 'reverse', start: { xMeters: 4, yMeters: 0 }, end: { xMeters: 2, yMeters: 0 }, thicknessMeters: 0.15 },
    ];
    room.windows = [{ id: 'window', wallId: 'reverse', offsetMeters: 0.5, widthMeters: 0.5 }];
    room.objects = [{ id: 'socket', name: 'Socket', layer: 'technician', widthMeters: 0.2, depthMeters: 0.1, heightMeters: 0.2, xMeters: 3, yMeters: 0, wallMount: { wallId: 'reverse', offsetMeters: 1, elevationMeters: 1 } }];
    const editor = new FloorPlanEditor({ room, layer: 'technician', units: 'metric', onChange: () => {}, onSelection: () => {} });
    const select = editor.element.querySelector<HTMLSelectElement>('[aria-label="Editor view"]')!;
    select.value = 'first';
    select.dispatchEvent(new Event('change'));
    expect(editor.element.querySelector('.editor-elevation-window')?.getAttribute('x')).toBe('3');
    const internals = editor as unknown as EditorInternals & { handleObjectDrag(point: { xMeters: number; yMeters: number }): void; pointerUp(event: { pointerId: number }): void };
    internals.handleSelectionPointer({ xMeters: 2.8, yMeters: -1 }, editor.element.querySelector<SVGElement>('.editor-elevation-object')!);
    internals.handleObjectDrag({ xMeters: 3.3, yMeters: -1 });
    internals.pointerUp({ pointerId: 1 });
    expect(editor.getRoom().objects[0].wallMount?.offsetMeters).toBeCloseTo(0.5);
    internals.handleSelectionPointer({ xMeters: 3.5, yMeters: -1.2 }, editor.element.querySelector<SVGElement>('[data-resize-object="true"]')!);
    internals.handleObjectDrag({ xMeters: 3.7, yMeters: -1.2 });
    internals.pointerUp({ pointerId: 1 });
    expect(editor.getRoom().objects[0].widthMeters).toBeCloseTo(0.4);
    expect(editor.getRoom().objects[0].wallMount?.offsetMeters).toBeCloseTo(0.3);
  });

  it('only selects and edits elements belonging to the active layer', () => {
    const room = createRoom();
    room.walls = [{ id: 'wall', start: { xMeters: 0, yMeters: 0 }, end: { xMeters: 4, yMeters: 0 }, thicknessMeters: 0.15 }];
    room.doors = [{ id: 'door', wallId: 'wall', offsetMeters: 1, widthMeters: 0.9 }];
    room.objects = [
      { id: 'socket', name: 'Socket', layer: 'technician', widthMeters: 0.1, depthMeters: 0.1, heightMeters: 0.1, xMeters: 1, yMeters: 1 },
      { id: 'chair', name: 'Chair', widthMeters: 1, depthMeters: 1, heightMeters: 1, xMeters: 2, yMeters: 2 },
    ];
    for (const [layer, allowed, denied] of [
      ['builder', ['wall', 'door'], ['socket', 'chair']],
      ['technician', ['socket'], ['wall', 'door', 'chair']],
      ['designer', ['chair'], ['wall', 'door', 'socket']],
    ] as const) {
      const callbacks: string[] = [];
      const editor = new FloorPlanEditor({ room, layer, units: 'metric', onChange: () => {}, onSelection: () => {}, onMeasure: () => callbacks.push('wall'), onMeasureObject: (id) => callbacks.push(id), onOpening: () => callbacks.push('door') });
      const internals = editor as unknown as EditorInternals;
      for (const id of [...allowed, ...denied]) {
        const selector = `[data-wall-id="${id}"], [data-opening-id="${id}"], [data-object-id="${id}"]`;
        const target = editor.element.querySelector<SVGElement>(selector)!;
        internals.selection = null;
        internals.handleSelectionPointer({ xMeters: 1, yMeters: 1 }, target);
        const selected = internals.selection as EditorInternals['selection'];
        expect(selected?.id ?? null, `${layer}: ${id}`).toBe(allowed.includes(id as never) ? id : null);
        editor.element.querySelector<SVGElement>(selector)!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      }
      expect(callbacks.sort()).toEqual([...allowed].sort());
      expect(editor.updateObject('socket', { name: 'Changed' })).toBe(layer === 'technician');
      expect(editor.element.querySelector('[title="Wall tool"]') !== null).toBe(layer === 'builder');
    }
  });

  it('shrinks a rectangle when the top then bottom wall length changes', () => {
    const editor = rectangleEditor();
    editor.selection = { type: 'wall', id: 'w0' };
    editor.setWallLength(3);
    editor.selection = { type: 'wall', id: 'w2' };
    editor.setWallLength(2);
    expect(loop(editor)).toEqual([[1, 0, 3, 0], [3, 0, 3, 4], [3, 4, 1, 4], [1, 4, 1, 0]]);
  });

  it('opens distance editors on double-click targets', () => {
    const calls: string[] = [];
    const room = createRoom();
    room.walls = [{ id: 'wall-1', start: { xMeters: 0, yMeters: 0 }, end: { xMeters: 4, yMeters: 0 }, thicknessMeters: 0.15 }];
    room.doors = [{ id: 'door-1', wallId: 'wall-1', offsetMeters: 1, widthMeters: 0.9 }];
    room.objects = [{ id: 'object-1', name: 'Cabinet', widthMeters: 1, depthMeters: 0.6, heightMeters: 0.9, xMeters: 1, yMeters: 1 }];
    const editor = new FloorPlanEditor({
      room,
      units: 'metric',
      onChange: () => {},
      onSelection: () => {},
      onMeasure: (wall) => calls.push(`wall:${wall.id}`),
      onMeasureObject: (id) => calls.push(`object:${id}`),
      onOpening: (kind, id) => calls.push(`${kind}:${id}`),
    });

    for (const [selector, expected] of [
      ['[data-wall-id="wall-1"]', 'wall:wall-1'],
      ['[data-opening-id="door-1"]', 'door:door-1'],
      ['[data-object-id="object-1"]', 'object:object-1'],
    ]) {
      const target = editor.element.querySelector<SVGElement>(selector);
      target?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      expect(calls).toContain(expected);
    }
  });

  it('keeps neighbours attached when a wall is dragged', () => {
    const editor = rectangleEditor();
    editor.selection = { type: 'wall', id: 'w0' };
    editor.dragOrigin = { xMeters: 2, yMeters: 0 };
    editor.originalRoom = structuredClone(editor.room);
    editor.handleWallDrag({ xMeters: 3.5, yMeters: 1 });
    expect(loop(editor)).toEqual([[0, 1, 4, 1], [4, 1, 4, 4], [4, 4, 0, 4], [0, 4, 0, 1]]);
  });

  it('splits a wall into independently selectable segments around a selectable door', () => {
    const editor = rectangleEditor();
    editor.selection = { type: 'wall', id: 'w0' };
    editor.addDoorToSelectedWall(1);

    expect(editor.room.walls).toHaveLength(5);
    expect(editor.room.doors).toHaveLength(1);
    const [door] = editor.room.doors;
    expect(door.rightWallId).toBeTruthy();
    const left = editor.room.walls.find((wall) => wall.id === door.wallId);
    const right = editor.room.walls.find((wall) => wall.id === door.rightWallId);
    expect([left?.end.xMeters, left?.end.yMeters]).toEqual([1.5, 0]);
    expect([right?.start.xMeters, right?.start.yMeters]).toEqual([2.5, 0]);
    expect([right?.end.xMeters, right?.end.yMeters]).toEqual([4, 0]);

    const openingElement = editor.element.querySelector<SVGElement>('[data-opening-id]');
    editor.handleSelectionPointer({ xMeters: 2, yMeters: 0 }, openingElement);
    expect(editor.selection).toEqual({ type: 'door', id: door.id });

    editor.deleteSelection();
    expect(editor.room.walls).toHaveLength(4);
    expect(editor.room.doors).toHaveLength(0);
    expect(editor.room.walls[0].end).toEqual({ xMeters: 4, yMeters: 0 });
  });

  it('migrates existing overlay openings into a selectable wall chain', () => {
    const editor = rectangleEditor();
    editor.room.doors.push({ id: 'legacy-door', wallId: 'w0', offsetMeters: 0.2, widthMeters: 0.5 });
    editor.selection = { type: 'wall', id: 'w0' };
    editor.addDoorToSelectedWall(0.9);

    expect(editor.room.walls).toHaveLength(6);
    expect(editor.room.doors).toHaveLength(2);
    expect(editor.room.doors.every((door) => Boolean(door.rightWallId))).toBe(true);
    const legacyLeft = editor.room.walls.find((wall) => wall.id === editor.room.doors[0].wallId);
    const legacyRight = editor.room.walls.find((wall) => wall.id === editor.room.doors[0].rightWallId);
    expect([legacyLeft?.end.xMeters, legacyRight?.start.xMeters]).toEqual([0.2, 0.7]);
  });

  it('draws an object from two opposite corners', () => {
    const editor = rectangleEditor() as unknown as { room: { objects: Array<Record<string, number>> }; setTool(tool: string): void; addObjectPoint(p: { xMeters: number; yMeters: number }): void; updateObject(id: string, c: { widthMeters: number }): boolean };
    editor.setTool('object');
    editor.addObjectPoint({ xMeters: 3, yMeters: 2 });
    editor.addObjectPoint({ xMeters: 1, yMeters: 1 });
    const [object] = editor.room.objects;
    expect([object.xMeters, object.yMeters, object.widthMeters, object.depthMeters]).toEqual([1, 1, 2, 1]);
    expect(editor.updateObject(String(object.id), { widthMeters: 2.5 })).toBe(true);
    expect(object.widthMeters).toBe(2.5);
  });

  it('moves a dragged object', () => {
    const editor = rectangleEditor() as unknown as { room: { objects: Array<Record<string, unknown>> }; selection: unknown; dragOrigin: unknown; originalRoom: unknown; handleObjectDrag(p: { xMeters: number; yMeters: number }): boolean };
    editor.room.objects.push({ id: 'o1', name: 'Box', widthMeters: 1, depthMeters: 1, heightMeters: 1, xMeters: 1, yMeters: 1 });
    editor.selection = { type: 'object', id: 'o1' };
    editor.dragOrigin = { xMeters: 1.5, yMeters: 1.5 };
    editor.originalRoom = structuredClone(editor.room);
    expect(editor.handleObjectDrag({ xMeters: 2.5, yMeters: 2 })).toBe(true);
    expect([editor.room.objects[0].xMeters, editor.room.objects[0].yMeters]).toEqual([2, 1.5]);
  });
});
