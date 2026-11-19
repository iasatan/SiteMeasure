import { describe, expect, it } from 'vitest';
import { createRoom } from '../src/domain/models';
import { FloorPlanEditor } from '../src/editor/floor-plan-editor';

interface EditorInternals {
  room: { walls: Array<{ start: { xMeters: number; yMeters: number }; end: { xMeters: number; yMeters: number } }> };
  selection: { type: 'wall'; id: string } | null;
  dragOrigin: { xMeters: number; yMeters: number };
  originalRoom: unknown;
  setWallLength(lengthMeters: number): void;
  handleWallDrag(point: { xMeters: number; yMeters: number }): void;
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
});
