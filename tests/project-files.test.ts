import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyImportedProject, parseBackupFile, parseProjectFile, projectFilename, serializeBackup, serializeProject } from '../src/data/project-files';
import { createProject, createRoom, type ProjectPhoto } from '../src/domain/models';
import { ProjectValidationError } from '../src/data/schema';
import { SiteMeasureApp } from '../src/app';
import { LocalStorageProjectRepository } from '../src/data/local-storage-repository';
import type { DebugLog } from '../src/debug-log';
import * as projectExports from '../src/reports/project-exports';
import { ObjectLibrary } from '../src/data/object-library';
import { createObjectDefinition, OBJECT_PRESETS } from '../src/domain/furniture';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('project files', () => {
  it('warns while an autosave is pending and cancels that timer after an immediate save', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as {
      scheduleSave(project: ReturnType<typeof createProject>): void;
      save(project: ReturnType<typeof createProject>): boolean;
    };
    const project = createProject('Pending save');
    const save = vi.spyOn(LocalStorageProjectRepository.prototype, 'save');

    app.scheduleSave(project);
    const pendingUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(pendingUnload);
    expect(pendingUnload.defaultPrevented).toBe(true);

    expect(app.save(project)).toBe(true);
    expect(save).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(650);
    expect(save).toHaveBeenCalledOnce();
    root.remove();
  });

  it('keeps warning about unsaved work after an autosave fails', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as {
      scheduleSave(project: ReturnType<typeof createProject>): void;
    };
    vi.spyOn(LocalStorageProjectRepository.prototype, 'save').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });
    app.scheduleSave(createProject('Failed save'));
    vi.advanceTimersByTime(650);

    const failedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(failedUnload);
    expect(failedUnload.defaultPrevented).toBe(true);
    expect(root.querySelector('.save-indicator')?.textContent).toBe('Not saved');
    root.remove();
  });

  it('names shared dialogs and preserves the delete dialog when persistence fails', () => {
    const project = createProject('Delete failure');
    new LocalStorageProjectRepository(localStorage).save(project);
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as {
      showManageDialog(projectId: string): void;
      confirmDelete(project: ReturnType<typeof createProject>): void;
    };
    const dialog = root.querySelector<HTMLDialogElement>('.app-dialog')!;
    dialog.showModal = () => dialog.setAttribute('open', '');
    vi.spyOn(LocalStorageProjectRepository.prototype, 'delete').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });

    app.showManageDialog(project.id);
    expect(dialog.getAttribute('aria-labelledby')).toBe('dialog-title');
    expect(dialog.querySelector('#dialog-title')?.textContent).toBe(project.name);
    app.confirmDelete(project);
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Delete')!.click();

    expect(dialog.open).toBe(true);
    expect(root.querySelector('.notice')?.textContent).toBe('Storage unavailable');
    expect(dialog.querySelector('#dialog-title')?.textContent).toBe('Delete local copy?');
    root.remove();
  });

  it('reports duplicate and undo failures without discarding the project recovery state', () => {
    const project = createProject('Mutation failure');
    new LocalStorageProjectRepository(localStorage).save(project);
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as {
      showManageDialog(projectId: string): void;
      confirmDelete(project: ReturnType<typeof createProject>): void;
      undoDeletion: unknown;
    };
    const dialog = root.querySelector<HTMLDialogElement>('.app-dialog')!;
    dialog.showModal = () => dialog.setAttribute('open', '');
    dialog.close = () => dialog.removeAttribute('open');
    vi.spyOn(LocalStorageProjectRepository.prototype, 'duplicate').mockImplementation(() => {
      throw new Error('Duplicate unavailable');
    });
    app.showManageDialog(project.id);
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Duplicate')!.click();
    expect(dialog.open).toBe(true);
    expect(root.querySelector('.notice')?.textContent).toBe('Duplicate unavailable');

    vi.restoreAllMocks();
    app.confirmDelete(project);
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Delete')!.click();
    vi.spyOn(LocalStorageProjectRepository.prototype, 'save').mockImplementation(() => {
      throw new Error('Undo unavailable');
    });
    [...root.querySelectorAll<HTMLButtonElement>('.toast button')].find((item) => item.textContent === 'Undo')!.click();
    expect(root.querySelector('.notice')?.textContent).toBe('Undo unavailable');
    expect(app.undoDeletion).not.toBeNull();
    root.remove();
  });

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

  it('creates a room on the active room floor', () => {
    const project = createProject('Multiple floors');
    const upperRoom = createRoom('Upper room');
    project.buildings[0].floors.push({ id: 'upper-floor', name: 'Upper floor', level: 1, rooms: [upperRoom] });
    const repository = new LocalStorageProjectRepository(localStorage);
    repository.save(project);
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as {
      addRoom(project: ReturnType<typeof createProject>): void;
      activeRoomId: string;
      selectedProjectId: string | null;
      view: 'plan';
    };
    app.activeRoomId = upperRoom.id;
    app.selectedProjectId = project.id;
    app.view = 'plan';

    app.addRoom(project);

    const saved = repository.get(project.id)!;
    expect(saved.buildings[0].floors[0].rooms).toHaveLength(1);
    expect(saved.buildings[0].floors[1].rooms).toHaveLength(2);
    expect(root.querySelector<HTMLSelectElement>('[aria-label="Current room"]')?.value).toBe(saved.buildings[0].floors[1].rooms[1].id);
    root.remove();
  });

  it('does not let an older toast hide a newer message or expire deletion undo', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as {
      showToast(message: string, label?: string, action?: () => void): void;
      undoDeletion: { project: ReturnType<typeof createProject>; expiresAt: number } | null;
    };
    app.undoDeletion = { project: createProject('Undo'), expiresAt: Date.now() + 30_000 };
    app.showToast('Project deleted', 'Undo', () => {});
    vi.advanceTimersByTime(10_000);
    app.showToast('Another message');
    vi.advanceTimersByTime(3_999);
    expect(root.querySelector<HTMLElement>('.toast')?.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(root.querySelector<HTMLElement>('.toast')?.hidden).toBe(true);
    expect(app.undoDeletion).not.toBeNull();
    root.remove();
  });

  it('selects and deletes text annotations and confirms photo draft discard', () => {
    const project = createProject('Photo draft');
    const room = project.buildings[0].floors[0].rooms[0];
    const photo = {
      id: 'photo-draft', title: 'Wall', notes: '', dataUrl: 'data:image/jpeg;base64,AAAA', mimeType: 'image/jpeg' as const,
      width: 1200, height: 800, sizeBytes: 4, capturedAt: new Date().toISOString(),
      annotations: [
        { id: 'shape', type: 'rectangle' as const, x: 0.1, y: 0.2, endX: 0.8, endY: 0.7, color: '#e85d3f' },
        { id: 'text', type: 'text' as const, x: 0.3, y: 0.4, text: 'Existing label', color: '#e85d3f' },
      ],
    };
    room.photos.push(photo);
    const repository = new LocalStorageProjectRepository(localStorage);
    repository.save(project);
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as {
      showPhotoDialog(project: ReturnType<typeof createProject>, room: ReturnType<typeof createRoom>, photo: ProjectPhoto): void;
    };
    const dialog = root.querySelector<HTMLDialogElement>('.app-dialog')!;
    dialog.showModal = () => dialog.setAttribute('open', '');
    dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new Event('close')); };

    app.showPhotoDialog(project, room, photo);
    expect(dialog.querySelector('[data-photo-tool="arrow"]')?.getAttribute('aria-pressed')).toBe('true');
    const annotationSelect = dialog.querySelector<HTMLSelectElement>('[aria-label="Photo annotation"]')!;
    expect(annotationSelect.options).toHaveLength(2);
    annotationSelect.value = 'text';
    annotationSelect.dispatchEvent(new Event('change'));
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Delete selected annotation')!.click();
    expect(photo.annotations.map((annotation) => annotation.id)).toEqual(['shape']);

    dialog.querySelector<HTMLTextAreaElement>('[aria-label="Photo notes"]')!.value = 'Unsaved note';
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Close')!.click();
    expect(dialog.querySelector('#dialog-title')?.textContent).toBe('Discard photo edits?');
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Discard changes')!.click();
    expect(room.photos[0].annotations).toHaveLength(2);
    expect(room.photos[0].notes).toBe('');
    expect(repository.get(project.id)?.buildings[0].floors[0].rooms[0].photos[0].annotations).toHaveLength(2);
    root.remove();
  });

  it('round-trips a validated project', () => {
    const project = createProject('River & Oak / 12');
    project.buildings[0].floors[0].rooms[0].objects.push({ id: 'socket', name: 'Socket', layer: 'technician', widthMeters: 0.1, depthMeters: 0.1, heightMeters: 0.1, elevationMeters: 0.7, rotationRadians: Math.PI / 2 });
    const projectFile = parseProjectFile(serializeProject(project));
    const restored = projectFile.project;

    expect(restored).toEqual(project);
    expect(projectFile.applicationVersion).toBe(__APP_VERSION__);
    expect(projectFilename(project)).toBe('river-oak-12.sitemeasure.json');
  });

  it('round-trips a multi-project backup and rejects corrupt backup content', () => {
    const first = createProject('First backup project');
    const second = createProject('Second backup project');
    const serialized = serializeBackup([first, second]);
    const backup = parseBackupFile(serialized);
    expect(backup.projects).toEqual([first, second]);
    expect(backup.applicationVersion).toBe(__APP_VERSION__);
    expect(() => parseBackupFile('{bad json')).toThrow(ProjectValidationError);
    expect(() => parseBackupFile(JSON.stringify({
      format: 'sitemeasure-backup', formatVersion: 1, exportedAt: new Date().toISOString(), applicationVersion: '1.0.0', projects: [first, first],
    }))).toThrow(/duplicate project IDs/);
  });

  it('exports current projects before replacing them from a backup preview', () => {
    localStorage.clear();
    const existing = createProject('Current local project');
    const incoming = createProject('Restored project');
    const repository = new LocalStorageProjectRepository(localStorage);
    repository.save(existing);
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as {
      showBackupPreview(backup: ReturnType<typeof parseBackupFile>): void;
      downloadText(text: string, filename: string, mimeType: string, onComplete?: () => void): void;
    };
    const dialog = root.querySelector<HTMLDialogElement>('.app-dialog')!;
    dialog.showModal = () => dialog.setAttribute('open', '');
    dialog.close = () => dialog.removeAttribute('open');
    const downloads: string[] = [];
    app.downloadText = (text, _filename, _mimeType, onComplete) => { downloads.push(text); onComplete?.(); };

    app.showBackupPreview(parseBackupFile(serializeBackup([incoming])));
    expect(dialog.textContent).toContain('Restored project');
    expect(dialog.textContent).toContain('Projects on this device');
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Download current backup & replace')!.click();

    expect(parseBackupFile(downloads[0]).projects.map((project) => project.id)).toEqual([existing.id]);
    expect(repository.list().map((project) => project.id)).toEqual([incoming.id]);
    expect(dialog.open).toBe(false);
    root.remove();
  });

  it('does not replace projects until Bluefy backup sharing completes', async () => {
    localStorage.clear();
    const existing = createProject('Current local project');
    const incoming = createProject('Restored project');
    const repository = new LocalStorageProjectRepository(localStorage);
    repository.save(existing);
    let resolveShare!: () => void;
    let rejectShare!: (error: unknown) => void;
    const share = vi.fn<(data: ShareData) => Promise<void>>(() => new Promise((resolve, reject) => { resolveShare = resolve; rejectShare = reject; }));
    vi.stubGlobal('navigator', { userAgent: 'iPhone Bluefy/3.9.3', platform: 'iPhone', canShare: () => true, share });
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as { showBackupPreview(backup: ReturnType<typeof parseBackupFile>): void };
    const dialog = root.querySelector<HTMLDialogElement>('.app-dialog')!;
    dialog.showModal = () => dialog.setAttribute('open', '');
    dialog.close = () => dialog.removeAttribute('open');
    app.showBackupPreview(parseBackupFile(serializeBackup([incoming])));
    const restore = [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Download current backup & replace')!;
    restore.click();
    expect(repository.list().map((project) => project.id)).toEqual([existing.id]);
    rejectShare(new DOMException('Cancelled', 'AbortError'));
    await Promise.resolve();
    expect(repository.list().map((project) => project.id)).toEqual([existing.id]);
    expect(dialog.open).toBe(true);
    restore.click();
    expect(repository.list().map((project) => project.id)).toEqual([existing.id]);
    resolveShare();
    await Promise.resolve();
    expect(repository.list().map((project) => project.id)).toEqual([incoming.id]);
    expect(dialog.open).toBe(false);
    root.remove();
  });

  it('offers the backup download inside the restore dialog after a share failure', async () => {
    vi.useFakeTimers();
    localStorage.clear();
    const existing = createProject('Current local project');
    const incoming = createProject('Restored project');
    const repository = new LocalStorageProjectRepository(localStorage);
    repository.save(existing);
    vi.stubGlobal('navigator', { userAgent: 'iPhone Bluefy/3.9.3', platform: 'iPhone', canShare: () => true, share: () => Promise.reject(new Error('Share unavailable')) });
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: () => 'blob:test', revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as { showBackupPreview(backup: ReturnType<typeof parseBackupFile>): void };
    const dialog = root.querySelector<HTMLDialogElement>('.app-dialog')!;
    dialog.showModal = () => dialog.setAttribute('open', '');
    dialog.close = () => dialog.removeAttribute('open');
    app.showBackupPreview(parseBackupFile(serializeBackup([incoming])));
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Download current backup & replace')!.click();
    await Promise.resolve();
    expect(repository.list().map((project) => project.id)).toEqual([existing.id]);
    dialog.querySelector<HTMLButtonElement>('.export-share-fallback button')!.click();
    expect(click).toHaveBeenCalledOnce();
    expect(repository.list().map((project) => project.id)).toEqual([incoming.id]);
    vi.advanceTimersByTime(60000);
    root.remove();
  });

  it('shows the local replacement target and copy consequence in an import preview', () => {
    const local = createProject('Existing local job');
    const incoming = structuredClone(local);
    incoming.name = 'Incoming job';
    incoming.address = '12 Example Street';
    incoming.buildings[0].floors.push({ id: 'preview-floor', name: 'Upper floor', level: 1, rooms: [createRoom('Study')] });
    const repository = new LocalStorageProjectRepository(localStorage);
    repository.save(local);
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as {
      showImportPreview(project: ReturnType<typeof createProject>): void;
    };
    const dialog = root.querySelector<HTMLDialogElement>('.app-dialog')!;
    dialog.showModal = () => dialog.setAttribute('open', '');
    dialog.close = () => dialog.removeAttribute('open');

    app.showImportPreview(incoming);

    expect(dialog.textContent).toContain('12 Example Street');
    expect(dialog.textContent).toContain('Local project affected');
    expect(dialog.textContent).toContain('Existing local job');
    expect(dialog.textContent).toContain('Replace overwrites the local project shown above');
    expect([...dialog.querySelectorAll('button')].map((item) => item.textContent)).toContain('Import as copy (keep both)');
    expect([...dialog.querySelectorAll('button')].some((item) => item.textContent === 'Replace local copy: Existing local job')).toBe(true);
    root.remove();
  });

  it('shows target identity and device name in measurement history', () => {
    const project = createProject('History context');
    const room = project.buildings[0].floors[0].rooms[0];
    room.objects.push({ id: 'cabinet', name: 'Cabinet', widthMeters: 1, depthMeters: 0.5, heightMeters: 1 });
    room.measurements.push({ id: 'measure', targetType: 'other', targetId: 'cabinet', valueMeters: 1.2, capturedAt: new Date().toISOString(), source: 'bluetooth', deviceName: 'Meter A' });
    new LocalStorageProjectRepository(localStorage).save(project);
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as {
      openProject(id: string): void;
      setView(view: 'measure'): void;
    };
    app.openProject(project.id);
    app.setView('measure');

    const row = root.querySelector('.measurement-row')!;
    expect(row.textContent).toContain('Cabinet');
    expect(row.textContent).toContain('Meter A');
    expect(row.textContent).toContain(room.name);
    root.remove();
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

  it('shares other text exports on Bluefy', () => {
    const share = vi.fn<(data: ShareData) => Promise<void>>(() => Promise.resolve());
    vi.stubGlobal('navigator', { userAgent: 'iPhone Bluefy/3.9.3', platform: 'iPhone', canShare: () => true, share });
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as { downloadText(text: string, filename: string, mimeType: string): void };
    app.downloadText('measurement', 'measurements.csv', 'text/csv');
    expect(share).toHaveBeenCalledOnce();
    expect(share.mock.calls[0][0].files![0].name).toBe('measurements.csv');
    expect(share.mock.calls[0][0].files![0].type).toBe('text/csv;charset=utf-8');
    root.remove();
  });

  it('shares backup, CSV, SVG, and object exports from their buttons', () => {
    localStorage.clear();
    const project = createProject('Example');
    new LocalStorageProjectRepository(localStorage).save(project);
    new ObjectLibrary(localStorage).save(createObjectDefinition('Cabinet', OBJECT_PRESETS[0].build()));
    const share = vi.fn<(data: ShareData) => Promise<void>>(() => Promise.resolve());
    vi.stubGlobal('navigator', { userAgent: 'iPhone Bluefy/3.9.3', platform: 'iPhone', canShare: () => true, share });
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as {
      selectedProjectId: string;
      renderMore(main: HTMLElement): void;
      objectsPage: { render(main: HTMLElement): void };
    };
    app.selectedProjectId = project.id;
    const main = document.createElement('main');
    app.renderMore(main);
    for (const label of ['Export full backup', 'Export measurements CSV', 'Export room SVG']) {
      [...main.querySelectorAll('button')].find((item) => item.textContent === label)!.click();
    }
    app.objectsPage.render(main);
    [...main.querySelectorAll('button')].find((item) => item.textContent === 'Export all')!.click();
    const files = share.mock.calls.map(([data]) => data.files![0]);
    expect(files).toHaveLength(4);
    expect(files.map((file) => file.type)).toEqual(['application/json;charset=utf-8', 'text/csv;charset=utf-8', 'image/svg+xml;charset=utf-8', 'application/json;charset=utf-8']);
    expect(files.map((file) => file.name)).toEqual([expect.stringContaining('.sitemeasure-backup.json'), expect.stringContaining('.csv'), expect.stringContaining('.svg'), expect.stringContaining('.json')]);
    root.remove();
  });

  it('uses an attached link and delayed cleanup for non-project download fallback', () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { userAgent: 'iPhone Bluefy/3.9.3', platform: 'iPhone', canShare: () => false, share: vi.fn() });
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: () => 'blob:test', revokeObjectURL: revoke }));
    let attached = false;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { attached = this.isConnected; });
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as { downloadText(text: string, filename: string, mimeType: string): void };
    app.downloadText('data', 'scan.json', 'application/json');
    expect(attached).toBe(true);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60000);
    expect(revoke).toHaveBeenCalledWith('blob:test');
    root.remove();
  });

  it('shares scan JSON through the application exporter on Bluefy', () => {
    const share = vi.fn<(data: ShareData) => Promise<void>>(() => Promise.resolve());
    vi.stubGlobal('navigator', { userAgent: 'iPhone Bluefy/3.9.3', platform: 'iPhone', canShare: () => true, share });
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as { scanPage: { render(main: HTMLElement): void; dispose(): void } };
    const main = document.createElement('main');
    app.scanPage.render(main);
    [...main.querySelectorAll('button')].find((item) => item.textContent === 'Download JSON')!.click();
    expect(share).toHaveBeenCalledOnce();
    expect(share.mock.calls[0][0].files![0].name).toBe('sitemeasure-scan.json');
    app.scanPage.dispose();
    root.remove();
  });

  it('requests a fresh tap before sharing an asynchronously generated PNG on Bluefy', async () => {
    const share = vi.fn<(data: ShareData) => Promise<void>>(() => Promise.resolve());
    vi.stubGlobal('navigator', { userAgent: 'iPhone Bluefy/3.9.3', platform: 'iPhone', canShare: () => true, share });
    vi.spyOn(projectExports, 'svgToPng').mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as { exportRoomPng(project: ReturnType<typeof createProject>, room: ReturnType<typeof createRoom>): Promise<void> };
    const project = createProject('Example');
    await app.exportRoomPng(project, project.buildings[0].floors[0].rooms[0]);
    expect(share).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>('.toast-action')!.click();
    expect(share).toHaveBeenCalledOnce();
    expect(share.mock.calls[0][0].files![0].type).toBe('image/png');
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
