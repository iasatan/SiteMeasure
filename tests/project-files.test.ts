import { describe, expect, it } from 'vitest';
import { copyImportedProject, parseProjectFile, projectFilename, serializeProject } from '../src/data/project-files';
import { createProject } from '../src/domain/models';
import { ProjectValidationError } from '../src/data/schema';

describe('project files', () => {
  it('round-trips a validated project', () => {
    const project = createProject('River & Oak / 12');
    project.buildings[0].floors[0].rooms[0].objects.push({ id: 'socket', name: 'Socket', layer: 'technician', widthMeters: 0.1, depthMeters: 0.1, heightMeters: 0.1, elevationMeters: 0.7, rotationRadians: Math.PI / 2 });
    const restored = parseProjectFile(serializeProject(project)).project;

    expect(restored).toEqual(project);
    expect(projectFilename(project)).toBe('river-oak-12.sitemeasure.json');
  });

  it('rejects the wrong format and version', () => {
    expect(() => parseProjectFile('{"format":"other"}')).toThrow(ProjectValidationError);
    expect(() => parseProjectFile(JSON.stringify({ format: 'sitemeasure-project', formatVersion: 99 }))).toThrow(ProjectValidationError);
  });

  it('remaps every internal ID and wall reference when importing as a copy', () => {
    const project = createProject('Copy test');
    const room = project.buildings[0].floors[0].rooms[0];
    room.walls.push({ id: 'wall-original', start: { xMeters: 0, yMeters: 0 }, end: { xMeters: 3, yMeters: 0 }, thicknessMeters: 0.15 });
    room.doors.push({ id: 'door-original', wallId: 'wall-original', offsetMeters: 1, widthMeters: 0.9 });
    room.objects.push({ id: 'socket', name: 'Socket', layer: 'technician', widthMeters: 0.1, depthMeters: 0.1, heightMeters: 0.1, wallMount: { wallId: 'wall-original', offsetMeters: 1, elevationMeters: 0.3 } });
    room.measurements.push({ id: 'measure', targetType: 'other', targetId: 'socket', valueMeters: 1, capturedAt: '2026-01-01T00:00:00Z', source: 'manual', clearance: { side: 'left', wallId: 'wall-original' } });
    const copied = copyImportedProject(project);
    const copiedRoom = copied.buildings[0].floors[0].rooms[0];

    expect(copied.id).not.toBe(project.id);
    expect(copied.buildings[0].id).not.toBe(project.buildings[0].id);
    expect(copied.buildings[0].floors[0].id).not.toBe(project.buildings[0].floors[0].id);
    expect(copiedRoom.id).not.toBe(room.id);
    expect(copiedRoom.walls[0].id).not.toBe(room.walls[0].id);
    expect(copiedRoom.doors[0].wallId).toBe(copiedRoom.walls[0].id);
    expect(copiedRoom.objects[0].wallMount).toEqual({ wallId: copiedRoom.walls[0].id, offsetMeters: 1, elevationMeters: 0.3 });
    expect(copiedRoom.measurements[0].clearance).toEqual({ side: 'left', wallId: copiedRoom.walls[0].id });
    expect(copiedRoom.measurements[0].targetId).toBe(copiedRoom.objects[0].id);
    expect(parseProjectFile(serializeProject(project)).project.buildings[0].floors[0].rooms[0].objects[0].wallMount).toEqual(room.objects[0].wallMount);
  });

  it('rejects malformed manual measurements', () => {
    const project = createProject('Invalid measurement');
    project.buildings[0].floors[0].rooms[0].measurements.push({
      id: 'bad', targetType: 'wall', targetId: 'missing', valueMeters: Number.NaN, capturedAt: new Date().toISOString(), source: 'manual',
    });
    expect(() => serializeProject(project)).toThrow(ProjectValidationError);
  });

  it('rejects invalid wall attachment coordinates', () => {
    const project = createProject('Invalid mount');
    project.buildings[0].floors[0].rooms[0].objects.push({ id: 'socket', name: 'Socket', widthMeters: 0.1, depthMeters: 0.1, heightMeters: 0.1, wallMount: { wallId: 'wall', offsetMeters: 1, elevationMeters: -1 } });
    expect(() => serializeProject(project)).toThrow(ProjectValidationError);
  });
});
