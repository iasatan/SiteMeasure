import { createId, type Project, type ProjectPhoto } from '../domain/models';

export interface PhotoBlobStore {
  put(blobs: ReadonlyMap<string, Blob>): Promise<void>;
  get(id: string): Promise<Blob | null>;
}

export class IndexedDbPhotoStore implements PhotoBlobStore {
  private database: Promise<IDBDatabase> | undefined;

  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB, private readonly name = 'sitemeasure-photos') {}

  async put(blobs: ReadonlyMap<string, Blob>): Promise<void> {
    if (!blobs.size) return;
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('photos', 'readwrite');
      const store = transaction.objectStore('photos');
      for (const [id, blob] of blobs) store.put(blob, id);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('Photo storage transaction failed.'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Photo storage transaction failed.'));
    });
  }

  async get(id: string): Promise<Blob | null> {
    const database = await this.open();
    return new Promise<Blob | null>((resolve, reject) => {
      const transaction = database.transaction('photos', 'readonly');
      const request = transaction.objectStore('photos').get(id);
      request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
      request.onerror = () => reject(request.error ?? new Error('Photo could not be read.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Photo storage transaction failed.'));
    });
  }

  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = new Promise<IDBDatabase>((resolve, reject) => {
        if (!this.factory) { reject(new Error('Photo storage is unavailable in this browser.')); return; }
        let blocked = false;
        const request = this.factory.open(this.name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('photos');
        request.onsuccess = () => {
          const database = request.result;
          if (blocked) { database.close(); return; }
          database.onversionchange = () => { database.close(); this.database = undefined; };
          resolve(database);
        };
        request.onerror = () => reject(request.error ?? new Error('Photo storage is unavailable.'));
        request.onblocked = () => { blocked = true; reject(new Error('Photo storage is blocked by another tab.')); };
      }).catch((error: unknown) => { this.database = undefined; throw error; });
    }
    return this.database;
  }
}

export function projectPhotos(project: Project): ProjectPhoto[] {
  return project.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.rooms.flatMap((room) => room.photos)));
}

export async function externalizePhotos(project: Project, store: PhotoBlobStore): Promise<Project> {
  const copy = structuredClone(project);
  const blobs = new Map<string, Blob>();
  for (const photo of projectPhotos(copy)) {
    if (photo.dataUrl === undefined) continue;
    const bytes = atob(photo.dataUrl.slice(photo.dataUrl.indexOf(',') + 1));
    const data = Uint8Array.from(bytes, (character) => character.codePointAt(0)!);
    const id = createId();
    blobs.set(id, new Blob([data], { type: photo.mimeType }));
    photo.storageId = id;
    delete photo.dataUrl;
  }
  await store.put(blobs);
  return copy;
}

export async function hydratePhotos(project: Project, store: PhotoBlobStore): Promise<Project> {
  const copy = structuredClone(project);
  for (const photo of projectPhotos(copy)) {
    if (!photo.storageId) continue;
    const blob = await store.get(photo.storageId);
    if (!blob) throw new Error(`Photo "${photo.title}" is missing from device storage.`);
    photo.dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Photo could not be encoded.'));
      reader.onerror = () => reject(new Error('Photo could not be encoded.'));
      reader.readAsDataURL(blob);
    });
    delete photo.storageId;
  }
  return copy;
}