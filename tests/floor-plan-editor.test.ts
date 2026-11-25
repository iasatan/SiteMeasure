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
