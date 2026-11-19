import { APPLICATION_VERSION, type Project } from '../domain/models';
import { remapProjectIds } from './local-storage-repository';
import { ProjectValidationError, validateProject } from './schema';

export const PROJECT_FILE_VERSION = 1;
export const MAX_PROJECT_FILE_BYTES = 20 * 1024 * 1024;

export interface ProjectFile {
  format: 'sitemeasure-project';
  formatVersion: number;
  exportedAt: string;
  applicationVersion: string;
  project: Project;
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
