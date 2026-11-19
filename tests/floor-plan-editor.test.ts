import { describe, expect, it } from 'vitest';
import { createRoom } from '../src/domain/models';
import { FloorPlanEditor } from '../src/editor/floor-plan-editor';

function rectangleEditor(): any {
  const room = createRoom();
  const points = [[0, 0], [4, 0], [4, 4], [0, 4]].map(([xMeters, yMeters]) => ({ xMeters, yMeters }));
  room.points = points;
  room.walls = points.map((start, index) => ({ id: `w${index}`, start: { ...start }, end: { ...points[(index + 1) % 4] } })) as typeof room.walls;
  return new FloorPlanEditor({ room, units: 'metric', onChange: () => {}, onSelection: () => {}, onMeasure: () => {}, onOpening: () => {} } as never);
}

const loop = (editor: any) => editor.room.walls.map((wall: any) => [wall.start.xMeters, wall.start.yMeters, wall.end.xMeters, wall.end.yMeters].map((value: number) => Math.round(value * 1000) / 1000));

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
