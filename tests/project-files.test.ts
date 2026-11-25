import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyImportedProject, parseProjectFile, projectFilename, serializeProject } from '../src/data/project-files';
import { createProject } from '../src/domain/models';
import { ProjectValidationError } from '../src/data/schema';
import { SiteMeasureApp } from '../src/app';
import { LocalStorageProjectRepository } from '../src/data/local-storage-repository';
import type { DebugLog } from '../src/debug-log';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('project files', () => {
  it('opens a new room ready to draw without replacing the existing room', () => {
    const project = createProject('New room drawing');
    const firstRoom = structuredClone(project.buildings[0].floors[0].rooms[0]);
    const repository = new LocalStorageProjectRepository(localStorage);
    repository.save(project);
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as { openProject(id: string): void };
    app.openProject(project.id);
    expect(root.querySelector('[aria-label="Room tool"]')?.classList.contains('is-active')).toBe(true);
    const newRoom = [...root.querySelectorAll('button')].find((button) => button.textContent === 'New room')!;
    newRoom.click();
    expect(root.querySelector('[aria-label="Room tool"]')?.classList.contains('is-active')).toBe(true);
    const rooms = repository.get(project.id)!.buildings[0].floors[0].rooms;
    expect(rooms).toHaveLength(2);
    expect(rooms[0]).toEqual(firstRoom);
    expect(root.querySelector<HTMLSelectElement>('[aria-label="Current room"]')?.value).toBe(rooms[1].id);
    repository.delete(project.id);
  });

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

  it('records each project download step without logging project contents', () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const root = document.createElement('div');
    document.body.append(root);
    const app = new SiteMeasureApp(root, undefined, { log } as unknown as DebugLog) as unknown as { exportProject(project: ReturnType<typeof createProject>): void };
    const objectUrl = vi.fn(() => 'blob:test');
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: objectUrl, revokeObjectURL: revoke }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const project = createProject('Example');
    project.description = 'Private project contents';
    app.exportProject(project);
    const steps = log.mock.calls.filter(([type]) => type === 'project-export').map(([, detail]) => detail.step);
    expect(steps).toEqual(['starting', 'serializing', 'serialized', 'blob-created', 'creating-object-url', 'object-url-created', 'link-created', 'clicking-link', 'link-click-returned', 'object-url-revocation-scheduled', 'download-requested']);
    expect(log).toHaveBeenCalledWith('project-export', expect.objectContaining({ step: 'clicking-link', attachedToDocument: true }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('Private project contents');
    expect(objectUrl).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60000);
    expect(revoke).toHaveBeenCalledWith('blob:test');
    expect(root.querySelector('.toast')?.textContent).toContain('download requested');
    root.remove();
  });

  it('shares a project file on Bluefy when file sharing is supported', async () => {
    const log = vi.fn();
    const canShare = vi.fn(() => true);
    const share = vi.fn<(data: ShareData) => Promise<void>>(() => Promise.resolve());
    vi.stubGlobal('navigator', { userAgent: 'iPhone Bluefy/3.9.3', platform: 'iPhone', canShare, share });
    const root = document.createElement('div');
    document.body.append(root);
    const app = new SiteMeasureApp(root, undefined, { log } as unknown as DebugLog) as unknown as { exportProject(project: ReturnType<typeof createProject>): void };
    app.exportProject(createProject('Example'));
    expect(canShare).toHaveBeenCalledOnce();
    expect(share).toHaveBeenCalledOnce();
    const file = share.mock.calls[0][0].files![0];
    expect(file.name).toBe('example.sitemeasure.json');
    expect(file.type).toBe('application/json');
    expect(file.size).toBeGreaterThan(0);
    await Promise.resolve();
    expect(log).toHaveBeenCalledWith('project-export', expect.objectContaining({ step: 'share-completed' }));
    root.remove();
  });

  it('uses the download fallback when Bluefy cannot share files', () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const share = vi.fn();
    vi.stubGlobal('navigator', { userAgent: 'iPhone Bluefy/3.9.3', platform: 'iPhone', canShare: () => false, share });
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: () => 'blob:test', revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const root = document.createElement('div');
    document.body.append(root);
    const app = new SiteMeasureApp(root, undefined, { log } as unknown as DebugLog) as unknown as { exportProject(project: ReturnType<typeof createProject>): void };
    app.exportProject(createProject('Example'));
    expect(share).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('project-export', { step: 'file-share-capability', canShare: false });
    vi.advanceTimersByTime(60000);
    root.remove();
  });

  it('offers a download after share failure but not when the share is cancelled', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const share = vi.fn<(data: ShareData) => Promise<void>>(() => Promise.reject(new Error('Share unavailable')));
    vi.stubGlobal('navigator', { userAgent: 'iPhone Bluefy/3.9.3', platform: 'iPhone', canShare: () => true, share });
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: () => 'blob:test', revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const root = document.createElement('div');
    document.body.append(root);
    const app = new SiteMeasureApp(root, undefined, { log } as unknown as DebugLog) as unknown as { exportProject(project: ReturnType<typeof createProject>): void };
    app.exportProject(createProject('Example'));
    await Promise.resolve();
    expect(log).toHaveBeenCalledWith('project-export.failed', { stage: 'sharing-file', error: 'Error: Share unavailable' });
    root.querySelector<HTMLButtonElement>('.toast-action')!.click();
    expect(click).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60000);
    share.mockImplementation(() => Promise.reject(new DOMException('Cancelled', 'AbortError')));
    app.exportProject(createProject('Example'));
    await Promise.resolve();
    expect(log).toHaveBeenCalledWith('project-export', { step: 'share-cancelled' });
    expect(root.querySelector('.toast-action')).toBeNull();
    expect(click).toHaveBeenCalledOnce();
    root.remove();
  });

  it('records serialization failures and reports them without requesting a download', () => {
    const log = vi.fn();
    const root = document.createElement('div');
    document.body.append(root);
    const app = new SiteMeasureApp(root, undefined, { log } as unknown as DebugLog) as unknown as { exportProject(project: ReturnType<typeof createProject>): void };
    const project = createProject('Invalid');
    project.buildings[0].floors[0].rooms[0].measurements.push({ id: 'bad', targetType: 'wall', targetId: 'missing', valueMeters: NaN, capturedAt: new Date().toISOString(), source: 'manual' });
    app.exportProject(project);
    expect(log).toHaveBeenCalledWith('project-export.failed', expect.objectContaining({ stage: 'serializing', error: expect.stringContaining('ProjectValidationError') }));
    expect(log).toHaveBeenCalledWith('project-export.error', expect.any(ProjectValidationError));
    expect(root.querySelector('.toast')?.textContent).toContain('export failed');
    root.remove();
  });

  it('identifies a failed download click even after object URL cleanup', () => {
    const log = vi.fn();
    const root = document.createElement('div');
    document.body.append(root);
    const app = new SiteMeasureApp(root, undefined, { log } as unknown as DebugLog) as unknown as { exportProject(project: ReturnType<typeof createProject>): void };
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: () => 'blob:test', revokeObjectURL: revoke }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('Download blocked'); });
    app.exportProject(createProject('Example'));
    expect(log).toHaveBeenCalledWith('project-export.failed', { stage: 'clicking-link', error: 'Error: Download blocked' });
    expect(log).toHaveBeenCalledWith('project-export', expect.objectContaining({ step: 'object-url-revoked' }));
    expect(revoke).toHaveBeenCalledWith('blob:test');
    expect(root.querySelector('.toast')?.textContent).toContain('export failed');
    root.remove();
  });

  it('selects the debug log for copying when clipboard access is unavailable', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = { enabled: false, startedAt: '2026-01-01', stoppedAt: '2026-01-01', entries: [{ time: 'now', type: 'project-export', detail: 'download-requested' }], dropped: 0 };
    const app = new SiteMeasureApp(root, undefined, { log: vi.fn(), current: session } as unknown as DebugLog) as unknown as { showDebugLog(): void };
    const dialog = root.querySelector<HTMLDialogElement>('dialog')!;
    dialog.showModal = () => dialog.setAttribute('open', '');
    app.showDebugLog();
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Copy log')!.click();
    expect(window.getSelection()?.toString()).toContain('download-requested');
    expect(dialog.querySelector('[role="status"]')?.textContent).toContain('Use your device copy command');
    window.getSelection()?.removeAllRanges();
    root.remove();
  });
});
