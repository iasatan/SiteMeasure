import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateProject } from '../src/data/schema';
import { remapProjectIds } from '../src/data/local-storage-repository';
import { createProject, type ProjectPhoto, type Room } from '../src/domain/models';
import { processPhoto, resizedDimensions } from '../src/photos/photo-processing';
import { renderPhotoAnnotations } from '../src/photos/photo-annotations';
import { externalizePhotos, hydratePhotos, IndexedDbPhotoStore, type PhotoBlobStore } from '../src/data/photo-store';
import { LocalStorageProjectRepository, STORAGE_KEYS } from '../src/data/local-storage-repository';
import { parseBackupFile, parseProjectFile, serializeBackup, serializeProject } from '../src/data/project-files';
import { IDBFactory } from 'fake-indexeddb';
import { SiteMeasureApp } from '../src/app';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function photoStore() {
  const clone = globalThis.structuredClone;
  vi.spyOn(globalThis, 'structuredClone').mockImplementation(((value: unknown) => value instanceof Blob ? value : clone(value)) as typeof structuredClone);
  return new IndexedDbPhotoStore(new IDBFactory());
}

function projectWithPhoto() {
  const project = createProject('Photo project');
  project.buildings[0].floors[0].rooms[0].photos.push({
    id: 'photo-1', title: 'Wall', notes: 'Check crack', dataUrl: 'data:image/jpeg;base64,AAAA', mimeType: 'image/jpeg',
    width: 1200, height: 800, sizeBytes: 20_000, capturedAt: '2026-01-01T00:00:00.000Z',
    annotations: [{ id: 'annotation-1', type: 'arrow', x: 0.1, y: 0.2, endX: 0.5, endY: 0.6, color: '#e85d3f' }],
  });
  return project;
}

describe('photo processing', () => {
  it('preserves aspect ratio below the maximum dimension', () => {
    expect(resizedDimensions(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(resizedDimensions(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });

  it('rejects undecodable dimensions', () => {
    expect(() => resizedDimensions(0, 400, 1600)).toThrow('invalid dimensions');
  });

  it('keeps new compressed photos binary', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4000, height: 3000, close })));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(new Blob(['image'], { type: 'image/jpeg' })));
    const result = await processPhoto(new File(['image'], 'wall.jpg', { type: 'image/jpeg' }));
    expect(result.photo.dataUrl).toBeUndefined();
    expect(result.photo.storageId).toBeTruthy();
    expect(result.photo.width).toBe(1600);
    expect(result.blob.type).toBe('image/jpeg');
    expect(close).toHaveBeenCalledOnce();
  });

  it('validates compressed photos and rejects MIME mismatches', () => {
    const project = projectWithPhoto();
    expect(() => validateProject(project)).not.toThrow();
    project.buildings[0].floors[0].rooms[0].photos[0].dataUrl = 'data:image/png;base64,AAAA';
    expect(() => validateProject(project)).toThrow('does not match its MIME type');
  });

  it('remaps photo and annotation IDs when projects are copied', () => {
    const copy = remapProjectIds(projectWithPhoto());
    const photo = copy.buildings[0].floors[0].rooms[0].photos[0];
    expect(photo.id).not.toBe('photo-1');
    expect(photo.annotations[0].id).not.toBe('annotation-1');
  });

  it('validates and renders measured annotation dimensions', () => {
    const project = projectWithPhoto();
    const annotation = project.buildings[0].floors[0].rooms[0].photos[0].annotations[0];
    annotation.lengthMeters = 2;
    expect(validateProject(project).buildings[0].floors[0].rooms[0].photos[0].annotations[0].lengthMeters).toBe(2);
    const image = document.createElement('img');
    Object.defineProperties(image, { naturalWidth: { value: 1200 }, naturalHeight: { value: 800 } });
    const overlay = renderPhotoAnnotations(image, [annotation], 'imperial', annotation.id);
    expect(overlay.textContent).toContain('6.56 ft');
    expect(overlay.querySelector('.annotation-selected')).not.toBeNull();
    annotation.lengthMeters = -1;
    expect(() => validateProject(project)).toThrow('lengthMeters');
  });

  it('stores photo blobs and creates portable project and backup files', async () => {
    const store = photoStore();
    const project = projectWithPhoto();
    const stored = await externalizePhotos(project, store);
    const photo = stored.buildings[0].floors[0].rooms[0].photos[0];
    expect(photo.dataUrl).toBeUndefined();
    expect(photo.storageId).toBeTruthy();
    expect(project.buildings[0].floors[0].rooms[0].photos[0].dataUrl).toBe('data:image/jpeg;base64,AAAA');
    expect(() => serializeProject(stored)).toThrow('must contain their photo data');
    const restored = await hydratePhotos(stored, store);
    expect(parseProjectFile(serializeProject(restored)).project).toEqual(project);
    expect(parseBackupFile(serializeBackup([restored])).projects).toEqual([project]);
  });

  it('migrates embedded photos only after the blob transaction succeeds', async () => {
    localStorage.clear();
    const repository = new LocalStorageProjectRepository(localStorage);
    const project = projectWithPhoto();
    repository.save(project);
    const key = `${STORAGE_KEYS.projectPrefix}${project.id}`;
    const original = localStorage.getItem(key);
    const failingStore: PhotoBlobStore = { put: async () => { throw new Error('Storage unavailable'); }, get: async () => null };
    await expect(repository.migratePhotos(failingStore)).rejects.toThrow('Storage unavailable');
    expect(localStorage.getItem(key)).toBe(original);
    const store = photoStore();
    await repository.migratePhotos(store);
    expect(localStorage.getItem(key)).not.toContain('data:image/jpeg');
    const migrated = repository.get(project.id)!;
    expect(await hydratePhotos(migrated, store)).toEqual(project);
    const copy = repository.duplicate(project.id);
    expect(await hydratePhotos(copy, store)).toEqual(remapForComparison(copy, project));
  });

  it('fails exports when a referenced photo is missing', async () => {
    const project = projectWithPhoto();
    const photo = project.buildings[0].floors[0].rooms[0].photos[0];
    delete photo.dataUrl;
    photo.storageId = 'missing';
    const store: PhotoBlobStore = { put: async () => {}, get: async () => null };
    await expect(hydratePhotos(project, store)).rejects.toThrow('missing from device storage');
  });

  it('imports photos into blob storage and exports them in a full backup before restore', async () => {
    localStorage.clear();
    const store = photoStore();
    const repository = new LocalStorageProjectRepository(localStorage);
    const incoming = projectWithPhoto();
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as {
      photoStore: PhotoBlobStore;
      showImportPreview(project: ReturnType<typeof createProject>): void;
      showBackupPreview(backup: ReturnType<typeof parseBackupFile>): void;
      downloadText(text: string, filename: string, mimeType: string, onComplete?: () => void): void;
    };
    app.photoStore = store;
    const dialog = root.querySelector<HTMLDialogElement>('.app-dialog')!;
    dialog.showModal = () => dialog.setAttribute('open', '');
    dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new Event('close')); };
    app.showImportPreview(incoming);
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Import project')!.click();
    await vi.waitFor(() => expect(repository.get(incoming.id)?.buildings[0].floors[0].rooms[0].photos[0].storageId).toBeTruthy());
    expect(localStorage.getItem(`${STORAGE_KEYS.projectPrefix}${incoming.id}`)).not.toContain('data:image/jpeg');

    const replacement = projectWithPhoto();
    replacement.name = 'Restored photo project';
    let download = '';
    app.downloadText = (text, _filename, _mimeType, onComplete) => { download = text; onComplete?.(); };
    app.showBackupPreview(parseBackupFile(serializeBackup([replacement])));
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Download current backup & replace')!.click();
    await vi.waitFor(() => expect(repository.get(replacement.id)?.name).toBe(replacement.name));
    expect(parseBackupFile(download).projects).toEqual([incoming]);
    expect(await hydratePhotos(repository.get(replacement.id)!, store)).toEqual(replacement);
    root.remove();
  });

  it('saves a new binary photo before committing its project reference', async () => {
    localStorage.clear();
    const store = photoStore();
    const repository = new LocalStorageProjectRepository(localStorage);
    const project = createProject('New photo');
    repository.save(project);
    const photo = projectWithPhoto().buildings[0].floors[0].rooms[0].photos[0];
    delete photo.dataUrl;
    photo.storageId = 'new-blob';
    const blob = new Blob([new Uint8Array([0, 0, 0])], { type: 'image/jpeg' });
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as {
      photoStore: PhotoBlobStore;
      showProcessedPhotoConfirmation(project: ReturnType<typeof createProject>, room: Room, photo: ProjectPhoto, blob: Blob): void;
    };
    app.photoStore = store;
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: () => 'blob:preview', revokeObjectURL: vi.fn() }));
    const dialog = root.querySelector<HTMLDialogElement>('.app-dialog')!;
    dialog.showModal = () => dialog.setAttribute('open', '');
    dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new Event('close')); };
    app.showProcessedPhotoConfirmation(project, project.buildings[0].floors[0].rooms[0], photo, blob);
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Save photo')!.click();
    await vi.waitFor(() => expect(repository.get(project.id)?.buildings[0].floors[0].rooms[0].photos).toHaveLength(1));
    const saved = repository.get(project.id)!;
    expect(localStorage.getItem(`${STORAGE_KEYS.projectPrefix}${project.id}`)).not.toContain('data:image/jpeg');
    expect((await hydratePhotos(saved, store)).buildings[0].floors[0].rooms[0].photos[0].dataUrl).toBe('data:image/jpeg;base64,AAAA');
    root.remove();
  });

  it('does not overwrite a project changed during an asynchronous photo save', async () => {
    localStorage.clear();
    const project = projectWithPhoto();
    const repository = new LocalStorageProjectRepository(localStorage);
    repository.save(project);
    let finishWrite!: () => void;
    const store: PhotoBlobStore = { put: (blobs) => blobs.size ? new Promise((resolve) => { finishWrite = resolve; }) : Promise.resolve(), get: async () => null };
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as {
      photoStore: PhotoBlobStore;
      saveWithPhotos(project: ReturnType<typeof createProject>, onSaved: () => void): void;
    };
    app.photoStore = store;
    const onSaved = vi.fn();
    app.saveWithPhotos(project, onSaved);
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    const updated = structuredClone(project);
    updated.name = 'Changed elsewhere';
    repository.save(updated);
    finishWrite();
    await vi.waitFor(() => expect(root.querySelector('.notice')?.textContent).toContain('changed while photos were being saved'));
    expect(repository.get(project.id)?.name).toBe('Changed elsewhere');
    expect(onSaved).not.toHaveBeenCalled();
    root.remove();
  });

  it('does not replace changed projects when preparing a recovery backup', async () => {
    localStorage.clear();
    const store = photoStore();
    const repository = new LocalStorageProjectRepository(localStorage);
    const existing = projectWithPhoto();
    repository.save(await externalizePhotos(existing, store));
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as {
      photoStore: PhotoBlobStore;
      showBackupPreview(backup: ReturnType<typeof parseBackupFile>): void;
      downloadText: ReturnType<typeof vi.fn>;
    };
    app.photoStore = store;
    app.downloadText = vi.fn();
    const dialog = root.querySelector<HTMLDialogElement>('.app-dialog')!;
    dialog.showModal = () => dialog.setAttribute('open', '');
    app.showBackupPreview(parseBackupFile(serializeBackup([createProject('Replacement')])));
    const updated = repository.get(existing.id)!;
    updated.name = 'Edited elsewhere';
    repository.save(updated);
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Download current backup & replace')!.click();
    expect(root.querySelector('.notice')?.textContent).toContain('Local projects changed');
    expect(repository.get(existing.id)?.name).toBe('Edited elsewhere');
    expect(app.downloadText).not.toHaveBeenCalled();
    root.remove();
  });

  it('does not complete a photo import after its dialog is closed', async () => {
    localStorage.clear();
    const repository = new LocalStorageProjectRepository(localStorage);
    const incoming = projectWithPhoto();
    let finishWrite!: () => void;
    const store: PhotoBlobStore = { put: (blobs) => blobs.size ? new Promise((resolve) => { finishWrite = resolve; }) : Promise.resolve(), get: async () => null };
    const root = document.createElement('div');
    const app = new SiteMeasureApp(root) as unknown as { photoStore: PhotoBlobStore; showImportPreview(project: ReturnType<typeof createProject>): void };
    app.photoStore = store;
    const dialog = root.querySelector<HTMLDialogElement>('.app-dialog')!;
    dialog.showModal = () => dialog.setAttribute('open', '');
    dialog.close = () => dialog.removeAttribute('open');
    app.showImportPreview(incoming);
    [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Import project')!.click();
    dialog.close();
    finishWrite();
    await vi.waitFor(() => expect((app as unknown as { pendingPhotoWrites: number }).pendingPhotoWrites).toBe(0));
    expect(repository.get(incoming.id)).toBeNull();
    root.remove();
  });
});

function remapForComparison(copy: ReturnType<typeof createProject>, original: ReturnType<typeof createProject>) {
  const expected = structuredClone(copy);
  const photo = expected.buildings[0].floors[0].rooms[0].photos[0];
  photo.dataUrl = original.buildings[0].floors[0].rooms[0].photos[0].dataUrl;
  delete photo.storageId;
  return expected;
}
