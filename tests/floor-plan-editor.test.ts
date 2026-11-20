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
  it('shrinks a rectangle when the top then bottom wall length changes', () => {
    const editor = rectangleEditor();
    editor.selection = { type: 'wall', id: 'w0' };
    editor.setWallLength(3);
    editor.selection = { type: 'wall', id: 'w2' };
    editor.setWallLength(2);
    expect(loop(editor)).toEqual([[1, 0, 3, 0], [3, 0, 3, 4], [3, 4, 1, 4], [1, 4, 1, 0]]);
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
