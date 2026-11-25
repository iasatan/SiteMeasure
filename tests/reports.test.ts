import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { SiteMeasureApp } from '../src/app';
import { LocalStorageProjectRepository } from '../src/data/local-storage-repository';
import { createProject, createRoom } from '../src/domain/models';
import { FloorPlanEditor } from '../src/editor/floor-plan-editor';
import { csvCell, floorPlanSvg, measurementsCsv, printableReport } from '../src/reports/project-exports';
import { roomViewerHtml } from '../src/reports/room-viewer-export';
import { createRoomPreview, createRoomScene, wallViewGeometry } from '../src/reports/room-visualization';

vi.mock('../src/reports/room-visualization', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/reports/room-visualization')>(),
  createRoomPreview: vi.fn(),
}));

describe('project reports', () => {
  it('builds the wall above and below split windows and above split doors', () => {
    const room = createRoom();
    room.points = [{ xMeters: 0, yMeters: 0 }, { xMeters: 5, yMeters: 0 }, { xMeters: 5, yMeters: 3 }];
    room.walls = [
      { id: 'left', start: room.points[0], end: { xMeters: 1, yMeters: 0 }, thicknessMeters: 0.15 },
      { id: 'middle', start: { xMeters: 2, yMeters: 0 }, end: { xMeters: 3, yMeters: 0 }, thicknessMeters: 0.15 },
      { id: 'right', start: { xMeters: 4, yMeters: 0 }, end: room.points[1], thicknessMeters: 0.15 },
    ];
    room.windows = [{ id: 'window', wallId: 'left', rightWallId: 'middle', offsetMeters: 1, widthMeters: 1 }];
    room.doors = [{ id: 'door', wallId: 'middle', rightWallId: 'right', offsetMeters: 1, widthMeters: 1 }];
    const scene = createRoomScene(room);
    const wallMeshes = (id: string) => scene.children.find((child) => child.userData.wallId === id)!.children as THREE.Mesh<THREE.BoxGeometry>[];
    const windowWall = wallMeshes('left');
    expect(windowWall).toHaveLength(3);
    expect(windowWall[1].geometry.parameters.height).toBeCloseTo(0.9);
    expect(windowWall[1].position.y).toBeCloseTo(0.45);
    expect(windowWall[2].geometry.parameters.height).toBeCloseTo(0.6);
    expect(windowWall[2].position.y).toBeCloseTo(2.4);
    const doorWall = wallMeshes('middle');
    expect(doorWall).toHaveLength(2);
    expect(doorWall[1].geometry.parameters.height).toBeCloseTo(0.6);
    expect(doorWall[1].position.y).toBeCloseTo(2.4);
  });

  it('renders legacy openings with the correct door height and a room-height-clamped window sill', () => {
    const room = createRoom();
    room.heightMeters = 2;
    room.points = [{ xMeters: 0, yMeters: 0 }, { xMeters: 5, yMeters: 0 }, { xMeters: 5, yMeters: 3 }];
    room.walls = [{ id: 'wall', start: room.points[0], end: room.points[1], thicknessMeters: 0.15 }];
    room.doors = [{ id: 'door', wallId: 'wall', offsetMeters: 0.5, widthMeters: 1 }];
    room.windows = [{ id: 'window', wallId: 'wall', offsetMeters: 2, widthMeters: 1, heightMeters: 1.8 }];
    const wall = createRoomScene(room).children.find((child) => child.userData.wallId === 'wall')!;
    const meshes = wall.children as THREE.Mesh<THREE.BoxGeometry>[];
    expect(meshes).toHaveLength(4);
    expect(meshes[2].geometry.parameters.height).toBeCloseTo(0.2);
    expect(meshes[2].position.y).toBeCloseTo(0.1);
  });

  it('opens and reloads the 3D view with current editor data', async () => {
    const project = createProject('Current room');
    const room = project.buildings[0].floors[0].rooms[0];
    room.objects = [{ id: 'cabinet', name: 'Cabinet', widthMeters: 2, depthMeters: 1, heightMeters: 1, xMeters: 1, yMeters: 2 }];
    new LocalStorageProjectRepository(localStorage).save(project);
    const root = document.createElement('div');
    document.body.append(root);
    const app = new SiteMeasureApp(root) as unknown as {
      layer: 'designer';
      activeEditor: FloorPlanEditor;
      openProject(id: string): void;
      downloadText(text: string, filename: string, mimeType: string): void;
    };
    app.layer = 'designer';
    app.openProject(project.id);
    const dialog = root.querySelector<HTMLDialogElement>('dialog')!;
    dialog.showModal = () => dialog.setAttribute('open', '');
    dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new Event('close')); };
    const editor = app.activeEditor;
    (editor as unknown as { handleSelectionPointer(point: { xMeters: number; yMeters: number }, target: SVGElement | null): void }).handleSelectionPointer({ xMeters: 2, yMeters: 2.5 }, root.querySelector<SVGElement>('.editor-object'));
    [...root.querySelectorAll('button')].find((item) => item.textContent === 'Rotate 90°')!.click();
    const dispose = vi.fn();
    vi.mocked(createRoomPreview).mockReset().mockReturnValue({ dispose });
    const download = vi.spyOn(app, 'downloadText').mockImplementation(() => {});
    [...root.querySelectorAll('button')].find((item) => item.textContent === '3D view')!.click();
    await vi.waitFor(() => expect(createRoomPreview).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createRoomPreview).mock.calls[0][1].objects[0].rotationRadians).toBe(Math.PI / 2);
    const updated = editor.getRoom();
    updated.objects[0].name = 'Updated cabinet';
    editor.setRoom(updated);
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Reload 3D view')!.click();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createRoomPreview).mock.calls[1][1].objects[0].name).toBe('Updated cabinet');
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Download 3D view')!.click();
    expect(download.mock.calls[0][0]).toContain('Updated cabinet');
    dialog.close();
    expect(dispose).toHaveBeenCalledTimes(2);
    root.remove();
  });

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
