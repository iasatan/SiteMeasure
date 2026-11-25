import {
  SCHEMA_VERSION,
  createId,
  summarizeProject,
  type Project,
  type ProjectRepository,
  type ProjectSummary,
  type StorageUsage,
} from '../domain/models';
import { migrateProject, ProjectValidationError, validateProject } from './schema';

export const STORAGE_KEYS = {
  settings: 'sitemeasure:settings',
  projectIndex: 'sitemeasure:project-index',
  projectPrefix: 'sitemeasure:project:',
  bluetoothSettings: 'sitemeasure:bluetooth-settings',
  schemaVersion: 'sitemeasure:schema-version',
} as const;

export type RepositoryWarning = (message: string) => void;

export class ProjectPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProjectPersistenceError';
  }
}

export class LocalStorageProjectRepository implements ProjectRepository {
  private readonly storage: Storage;
  private readonly warn: RepositoryWarning;

  constructor(storage: Storage, warn: RepositoryWarning = () => undefined) {
    this.storage = storage;
    this.warn = warn;
    this.ensureSchema();
  }

  list(): ProjectSummary[] {
    const summaries = this.readIndex();
    const valid = summaries.filter((summary) => this.get(summary.id) !== null);
    return valid.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  }

  get(projectId: string): Project | null {
    const raw = this.storage.getItem(this.projectKey(projectId));
    if (!raw) return null;

    try {
      return validateProject(JSON.parse(raw));
    } catch {
      this.warn(`Project ${projectId} could not be opened. Its stored data was left unchanged.`);
      return null;
    }
  }

  save(project: Project): void {
    const validated = validateProject(project);
    const projectKey = this.projectKey(validated.id);
    const previousProject = this.storage.getItem(projectKey);
    const previousIndex = this.storage.getItem(STORAGE_KEYS.projectIndex);
    const index = this.readIndex().filter((summary) => summary.id !== validated.id);
    index.push(summarizeProject(validated));

    try {
      this.storage.setItem(projectKey, JSON.stringify(validated));
      this.storage.setItem(STORAGE_KEYS.projectIndex, JSON.stringify(index));
    } catch (error) {
      try {
        if (previousProject === null) this.storage.removeItem(projectKey);
        else this.storage.setItem(projectKey, previousProject);
        if (previousIndex === null) this.storage.removeItem(STORAGE_KEYS.projectIndex);
        else this.storage.setItem(STORAGE_KEYS.projectIndex, previousIndex);
      } catch {
        this.warn('Storage is full and could not be rolled back completely. Keep this tab open and export your work.');
      }
      throw new ProjectPersistenceError(this.persistenceMessage(error), { cause: error });
    }
  }

  delete(projectId: string): void {
    try {
      this.storage.removeItem(this.projectKey(projectId));
      const index = this.readIndex().filter((summary) => summary.id !== projectId);
      this.storage.setItem(STORAGE_KEYS.projectIndex, JSON.stringify(index));
    } catch (error) {
      throw new ProjectPersistenceError(this.persistenceMessage(error), { cause: error });
    }
  }

  duplicate(projectId: string): Project {
    const source = this.get(projectId);
    if (!source) throw new ProjectPersistenceError('The project could not be found.');

    const copy = remapProjectIds(source);
    copy.name = `${source.name} copy`;
    copy.createdAt = new Date().toISOString();
    copy.modifiedAt = copy.createdAt;
    this.save(copy);
    return copy;
  }

  getStorageUsage(): StorageUsage {
    let bytesUsed = 0;
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      if (!key?.startsWith('sitemeasure:')) continue;
      bytesUsed += key.length + (this.storage.getItem(key)?.length ?? 0);
    }
    const quotaBytes = 5 * 1024 * 1024;
    return {
      bytesUsed: bytesUsed * 2,
      quotaBytes,
      percentUsed: (bytesUsed * 2) / quotaBytes,
    };
  }

  private ensureSchema(): void {
    const rawVersion = this.storage.getItem(STORAGE_KEYS.schemaVersion);
    const version = Number(rawVersion ?? '0');
    if (version > SCHEMA_VERSION) {
      this.warn('This device contains data from a newer SiteMeasure version. New writes are disabled in this session.');
      return;
    }
    if (version === SCHEMA_VERSION) return;

    try {
      this.storage.setItem(`sitemeasure:migration-backup:${version}`, JSON.stringify(this.snapshotData()));
      this.migrateStoredProjects();
      this.storage.setItem(STORAGE_KEYS.schemaVersion, String(SCHEMA_VERSION));
    } catch (error) {
      throw new ProjectPersistenceError(this.persistenceMessage(error), { cause: error });
    }
  }

  private snapshotData(): Record<string, string> {
    const backup: Record<string, string> = {};
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      const value = key ? this.storage.getItem(key) : null;
      if (key?.startsWith('sitemeasure:') && value !== null) backup[key] = value;
    }
    return backup;
  }

  private migrateStoredProjects(): void {
    for (const key of Object.keys(this.storage)) {
      if (!key.startsWith(STORAGE_KEYS.projectPrefix)) continue;
      this.migrateStoredProject(key);
    }
  }

  private migrateStoredProject(key: string): void {
    const raw = this.storage.getItem(key);
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      const migrated = migrateProject(parsed) ?? validateProject(parsed);
      this.storage.setItem(key, JSON.stringify(migrated));
    } catch {
      this.warn(`Skipped invalid stored project ${key}. Its original value remains in the migration backup.`);
    }
  }

  private readIndex(): ProjectSummary[] {
    const raw = this.storage.getItem(STORAGE_KEYS.projectIndex);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new ProjectValidationError('Project index is not an array.');
      return parsed.filter((entry): entry is ProjectSummary => {
        if (!entry || typeof entry !== 'object') return false;
        const summary = entry as Partial<ProjectSummary>;
        return typeof summary.id === 'string' && typeof summary.name === 'string' && typeof summary.modifiedAt === 'string';
      });
    } catch {
      this.warn('The project index is damaged. Stored project files were not changed; export or restore a backup.');
      return [];
    }
  }

  private projectKey(projectId: string): string {
    return `${STORAGE_KEYS.projectPrefix}${projectId}`;
  }

  private persistenceMessage(error: unknown): string {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      return 'Device storage is full. Your latest changes were not saved. Export a backup before clearing space.';
    }
    return 'SiteMeasure could not save this project on the device. Keep this tab open and export a backup.';
  }
}

export function remapProjectIds(project: Project): Project {
  const projectCopy = structuredClone(project);
  const idMap = new Map<string, string>();
  projectCopy.id = mappedId(idMap, projectCopy.id);
  projectCopy.buildings.forEach((building) => remapBuildingIds(building, idMap));
  return validateProject(projectCopy);
}

function remapBuildingIds(building: Project['buildings'][number], idMap: Map<string, string>): void {
  building.id = mappedId(idMap, building.id);
  building.floors.forEach((floor) => {
    floor.id = mappedId(idMap, floor.id);
    floor.rooms.forEach((room) => remapRoomIds(room, idMap));
  });
}

function remapRoomIds(room: Project['buildings'][number]['floors'][number]['rooms'][number], idMap: Map<string, string>): void {
  room.id = mappedId(idMap, room.id);
  room.walls.forEach((wall) => { wall.id = mappedId(idMap, wall.id); });
  room.doors.forEach((door) => {
    door.id = mappedId(idMap, door.id);
    door.wallId = mappedId(idMap, door.wallId);
    if (door.rightWallId) door.rightWallId = mappedId(idMap, door.rightWallId);
  });
  room.windows.forEach((window) => {
    window.id = mappedId(idMap, window.id);
    window.wallId = mappedId(idMap, window.wallId);
    if (window.rightWallId) window.rightWallId = mappedId(idMap, window.rightWallId);
  });
  room.objects.forEach((object) => {
    object.id = mappedId(idMap, object.id);
    if (object.wallMount) object.wallMount.wallId = mappedId(idMap, object.wallMount.wallId);
  });
  room.measurements.forEach((measurement) => {
    measurement.id = mappedId(idMap, measurement.id);
    measurement.targetId = mappedId(idMap, measurement.targetId);
    if (measurement.clearance) measurement.clearance.wallId = mappedId(idMap, measurement.clearance.wallId);
  });
  room.photos.forEach((photo) => {
    photo.id = mappedId(idMap, photo.id);
    photo.annotations.forEach((annotation) => { annotation.id = mappedId(idMap, annotation.id); });
  });
}

function mappedId(idMap: Map<string, string>, sourceId: string): string {
  const current = idMap.get(sourceId) ?? createId();
  idMap.set(sourceId, current);
  return current;
}
