import { APPLICATION_VERSION, type Project } from '../domain/models';
import { remapProjectIds } from './local-storage-repository';
import { ProjectValidationError, validateProject } from './schema';

export const PROJECT_FILE_VERSION = 1;
export const MAX_PROJECT_FILE_BYTES = 20 * 1024 * 1024;
export const BACKUP_FILE_VERSION = 1;
export const MAX_BACKUP_FILE_BYTES = 100 * 1024 * 1024;

export interface ProjectFile {
  format: 'sitemeasure-project';
  formatVersion: number;
  exportedAt: string;
  applicationVersion: string;
  project: Project;
}

export interface BackupFile {
  format: 'sitemeasure-backup';
  formatVersion: number;
  exportedAt: string;
  applicationVersion: string;
  projects: Project[];
}

export function createProjectFile(project: Project): ProjectFile {
  return {
    format: 'sitemeasure-project',
    formatVersion: PROJECT_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    applicationVersion: APPLICATION_VERSION,
    project: validateProject(project),
  };
}

export function serializeProject(project: Project): string {
  return JSON.stringify(createProjectFile(project), null, 2);
}

export function serializeBackup(projects: Project[]): string {
  const file: BackupFile = {
    format: 'sitemeasure-backup',
    formatVersion: BACKUP_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    applicationVersion: APPLICATION_VERSION,
    projects: projects.map(validateProject),
  };
  return JSON.stringify(file, null, 2);
}

export async function readBackupFile(file: File): Promise<BackupFile> {
  if (file.size > MAX_BACKUP_FILE_BYTES) {
    throw new ProjectValidationError('The selected backup is larger than the 100 MB backup limit.');
  }
  return parseBackupFile(await file.text());
}

export function parseBackupFile(text: string): BackupFile {
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_FILE_BYTES) {
    throw new ProjectValidationError('The selected backup is larger than the 100 MB backup limit.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProjectValidationError('The selected backup is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProjectValidationError('The backup file must contain an object.');
  }
  const file = parsed as Record<string, unknown>;
  if (Object.hasOwn(file, '__proto__')) throw new ProjectValidationError('The backup file contains unsafe data.');
  if (file.format !== 'sitemeasure-backup') throw new ProjectValidationError('This is not a SiteMeasure backup file.');
  if (file.formatVersion !== BACKUP_FILE_VERSION) throw new ProjectValidationError('This backup version is not supported.');
  if (typeof file.exportedAt !== 'string' || Number.isNaN(Date.parse(file.exportedAt))) throw new ProjectValidationError('The backup export date is invalid.');
  if (typeof file.applicationVersion !== 'string') throw new ProjectValidationError('The backup application version is invalid.');
  if (!Array.isArray(file.projects)) throw new ProjectValidationError('The backup project list is invalid.');
  const projects = file.projects.map(validateProject);
  if (new Set(projects.map((project) => project.id)).size !== projects.length) {
    throw new ProjectValidationError('The backup contains duplicate project IDs.');
  }
  return {
    format: 'sitemeasure-backup',
    formatVersion: BACKUP_FILE_VERSION,
    exportedAt: file.exportedAt,
    applicationVersion: file.applicationVersion,
    projects,
  };
}

export async function readProjectFile(file: File): Promise<Project> {
  if (file.size > MAX_PROJECT_FILE_BYTES) {
    throw new ProjectValidationError('The selected file is larger than the 20 MB project limit.');
  }

  const text = await file.text();
  return parseProjectFile(text).project;
}

export function parseProjectFile(text: string): ProjectFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProjectValidationError('The selected file is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProjectValidationError('The project file must contain an object.');
  }

  const file = parsed as Record<string, unknown>;
  if (Object.hasOwn(file, '__proto__')) {
    throw new ProjectValidationError('The project file contains unsafe data.');
  }
  if (file.format !== 'sitemeasure-project') {
    throw new ProjectValidationError('This is not a SiteMeasure project file.');
  }
  if (file.formatVersion !== PROJECT_FILE_VERSION) {
    const version = typeof file.formatVersion === 'number' ? String(file.formatVersion) : 'unknown';
    throw new ProjectValidationError(`Unsupported project file version ${version}.`);
  }
  if (typeof file.exportedAt !== 'string' || Number.isNaN(Date.parse(file.exportedAt))) {
    throw new ProjectValidationError('The project export date is invalid.');
  }
  if (typeof file.applicationVersion !== 'string') {
    throw new ProjectValidationError('The project application version is invalid.');
  }

  return {
    format: 'sitemeasure-project',
    formatVersion: PROJECT_FILE_VERSION,
    exportedAt: file.exportedAt,
    applicationVersion: file.applicationVersion,
    project: validateProject(file.project),
  };
}

export function copyImportedProject(project: Project): Project {
  const copy = remapProjectIds(project);
  copy.name = `${project.name} (imported)`;
  copy.createdAt = new Date().toISOString();
  copy.modifiedAt = copy.createdAt;
  return copy;
}

export function projectFilename(project: Project): string {
  const safeName = project.name
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'project';
  return `${safeName}.sitemeasure.json`;
}
