import { describe, expect, it } from 'vitest';
import { createProject, createRoom } from '../src/domain/models';
import { csvCell, floorPlanSvg, measurementsCsv, printableReport } from '../src/reports/project-exports';
import { roomViewerHtml } from '../src/reports/room-viewer-export';
import { wallViewGeometry } from '../src/reports/room-visualization';

describe('project reports', () => {
  it('frames split wall segments from inside the room', () => {
    const room = createRoom();
    room.points = [{ xMeters: 0, yMeters: 0 }, { xMeters: 4, yMeters: 0 }, { xMeters: 4, yMeters: 3 }, { xMeters: 0, yMeters: 3 }];
    room.walls = [
      { id: 'left', start: room.points[0], end: { xMeters: 1, yMeters: 0 }, thicknessMeters: 0.15 },
      { id: 'right', start: { xMeters: 2, yMeters: 0 }, end: room.points[1], thicknessMeters: 0.15 },
      { id: 'side', start: room.points[1], end: room.points[2], thicknessMeters: 0.15 },
      { id: 'separate', start: { xMeters: 7, yMeters: 0 }, end: { xMeters: 8, yMeters: 0 }, thicknessMeters: 0.15 },
    ];
    room.doors.push({ id: 'door', wallId: 'left', rightWallId: 'right', offsetMeters: 1, widthMeters: 1 });
    expect(wallViewGeometry(room, 'left')).toEqual({ wallIds: ['left', 'right'], centerX: 0, centerZ: -1.5, normalX: -0, normalZ: 1, width: 4 });
    expect(wallViewGeometry(room, 'missing')).toBeNull();
  });

  it('escapes CSV and neutralizes spreadsheet formulas', () => {
    expect(csvCell('A, B')).toBe('"A, B"');
    expect(csvCell('=1+1')).toBe("'=1+1");
  });

  it('exports measurements without executable project text', () => {
    const project = createProject('Job <script>');
    const room = project.buildings[0].floors[0].rooms[0];
    room.measurements.push({ id: 'm1', targetType: 'other', targetId: room.id, valueMeters: 2.5, capturedAt: '2026-01-01T00:00:00.000Z', source: 'manual' });
    expect(measurementsCsv(project)).toContain('Job <script>');
    expect(printableReport(project)).not.toContain('<script>');
    expect(printableReport(project)).toContain('&lt;script&gt;');
  });

  it('creates a standalone SVG for a room', () => {
    const project = createProject('Plan');
    const room = createRoom('Kitchen');
    room.points = [{ xMeters: 0, yMeters: 0 }, { xMeters: 4, yMeters: 0 }, { xMeters: 4, yMeters: 3 }];
    const svg = floorPlanSvg(project, room);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('<polygon');
  });

  it('creates a self-contained interactive 3D room export', () => {
    const room = createRoom('Kitchen & dining');
    room.notes.push('private note');
    room.objects.push({ id: 'object', name: '</script><script>alert(1)</script>', widthMeters: 1, heightMeters: 1, depthMeters: 1 });
    const html = roomViewerHtml('House <script>', room);

    expect(html).toContain('id="room-viewer"');
    expect(html).toContain('id="room-data"');
    expect(html).toContain('pointerdown');
    expect(html).not.toContain('private note');
    expect(html).not.toContain('</script><script>alert');
    expect(html).not.toContain('<img');
    expect(html).toContain('House &lt;script&gt;');
    expect(html).toContain('Kitchen &amp; dining');
  });
});
