import { describe, expect, it } from 'vitest';
import { copyImportedProject, parseProjectFile, projectFilename, serializeProject } from '../src/data/project-files';
import { createProject } from '../src/domain/models';
import { ProjectValidationError } from '../src/data/schema';

describe('project files', () => {
  it('round-trips a validated project', () => {
    const project = createProject('River & Oak / 12');
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
    const copied = copyImportedProject(project);
    const copiedRoom = copied.buildings[0].floors[0].rooms[0];

    expect(copied.id).not.toBe(project.id);
    expect(copied.buildings[0].id).not.toBe(project.buildings[0].id);
    expect(copied.buildings[0].floors[0].id).not.toBe(project.buildings[0].floors[0].id);
    expect(copiedRoom.id).not.toBe(room.id);
    expect(copiedRoom.walls[0].id).not.toBe(room.walls[0].id);
    expect(copiedRoom.doors[0].wallId).toBe(copiedRoom.walls[0].id);
  });

  it('rejects malformed manual measurements', () => {
    const project = createProject('Invalid measurement');
    project.buildings[0].floors[0].rooms[0].measurements.push({
      id: 'bad', targetType: 'wall', targetId: 'missing', valueMeters: Number.NaN, capturedAt: new Date().toISOString(), source: 'manual',
    });
    expect(() => serializeProject(project)).toThrow(ProjectValidationError);
  });
});
