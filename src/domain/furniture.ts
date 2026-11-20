import { APPLICATION_VERSION, createId } from './models';

export type PartShape = 'box' | 'cylinder';

/** A primitive centred at (x, y, z) in object space; y is up. Cylinders are elliptical across width × depth. */
export interface ObjectPart {
  id: string;
  shape: PartShape;
  xMeters: number;
  yMeters: number;
  zMeters: number;
  widthMeters: number;
  heightMeters: number;
  depthMeters: number;
  color: string;
}

export interface ObjectDefinition {
  id: string;
  name: string;
  parts: ObjectPart[];
  createdAt: string;
  modifiedAt: string;
}

export interface ObjectBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  widthMeters: number;
  heightMeters: number;
  depthMeters: number;
}

export const MAX_PARTS = 200;
export const OBJECT_FILE_FORMAT = 'sitemeasure-object';
export const OBJECT_FILE_VERSION = 1;

export class ObjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjectValidationError';
  }
}

export function createPart(shape: PartShape = 'box'): ObjectPart {
  return { id: createId(), shape, xMeters: 0, yMeters: 0.25, zMeters: 0, widthMeters: 0.5, heightMeters: 0.5, depthMeters: 0.5, color: '#8c7a6b' };
}

export function partBounds(parts: ObjectPart[]): ObjectBounds {
  if (!parts.length) {
    return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 }, widthMeters: 0, heightMeters: 0, depthMeters: 0 };
  }
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const part of parts) {
    min.x = Math.min(min.x, part.xMeters - part.widthMeters / 2);
    max.x = Math.max(max.x, part.xMeters + part.widthMeters / 2);
    min.y = Math.min(min.y, part.yMeters - part.heightMeters / 2);
    max.y = Math.max(max.y, part.yMeters + part.heightMeters / 2);
    min.z = Math.min(min.z, part.zMeters - part.depthMeters / 2);
    max.z = Math.max(max.z, part.zMeters + part.depthMeters / 2);
  }
  return { min, max, widthMeters: max.x - min.x, heightMeters: max.y - min.y, depthMeters: max.z - min.z };
}

export function createObjectDefinition(name: string, parts: ObjectPart[] = []): ObjectDefinition {
  const now = new Date().toISOString();
  return { id: createId(), name: name.trim() || 'Untitled object', parts: parts.map((part) => ({ ...part })), createdAt: now, modifiedAt: now };
}

function box(x: number, y: number, z: number, w: number, h: number, d: number, color: string, shape: PartShape = 'box'): ObjectPart {
  return { id: createId(), shape, xMeters: x, yMeters: y, zMeters: z, widthMeters: w, heightMeters: h, depthMeters: d, color };
}

export interface ObjectPreset {
  label: string;
  build: () => ObjectPart[];
}

export const OBJECT_PRESETS: ObjectPreset[] = [
  {
    label: 'Couch',
    build: () => [
      box(0, 0.2, 0, 2, 0.4, 0.9, '#6b7f8c'),
      box(0, 0.6, -0.35, 2, 0.5, 0.2, '#58707e'),
      box(-0.9, 0.5, 0.05, 0.2, 0.2, 0.8, '#58707e'),
      box(0.9, 0.5, 0.05, 0.2, 0.2, 0.8, '#58707e'),
    ],
  },
  {
    label: 'Fridge',
    build: () => [
      box(0, 0.9, 0, 0.7, 1.8, 0.7, '#e3e7e8'),
      box(0.28, 1.2, 0.36, 0.04, 0.5, 0.04, '#8a9296'),
      box(0.28, 0.5, 0.36, 0.04, 0.4, 0.04, '#8a9296'),
    ],
  },
  {
    label: 'Table',
    build: () => [
      box(0, 0.74, 0, 1.4, 0.06, 0.8, '#a0764f'),
      box(-0.62, 0.36, -0.32, 0.06, 0.72, 0.06, '#7d5a3a'),
      box(0.62, 0.36, -0.32, 0.06, 0.72, 0.06, '#7d5a3a'),
      box(-0.62, 0.36, 0.32, 0.06, 0.72, 0.06, '#7d5a3a'),
      box(0.62, 0.36, 0.32, 0.06, 0.72, 0.06, '#7d5a3a'),
    ],
  },
  {
    label: 'Bed',
    build: () => [
      box(0, 0.25, 0, 1.6, 0.5, 2, '#b9a88f'),
      box(0, 0.6, 0, 1.55, 0.2, 1.95, '#e8e2d6'),
      box(0, 0.7, -0.95, 1.6, 0.9, 0.1, '#7d5a3a'),
    ],
  },
  {
    label: 'Round stool',
    build: () => [box(0, 0.225, 0, 0.4, 0.45, 0.4, '#a0764f', 'cylinder')],
  },
];

function finite(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ObjectValidationError(`${path} is outside the allowed range.`);
  }
  return value;
}

export function validateParts(value: unknown, path = 'parts'): ObjectPart[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PARTS) {
    throw new ObjectValidationError(`${path} must contain 1 to ${MAX_PARTS} parts.`);
  }
  return value.map((raw, index) => {
    const at = `${path}[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ObjectValidationError(`${at} must be an object.`);
    const record = raw as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id.trim() || record.id.length > 200) throw new ObjectValidationError(`${at}.id is invalid.`);
    if (record.shape !== 'box' && record.shape !== 'cylinder') throw new ObjectValidationError(`${at}.shape is invalid.`);
    if (typeof record.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(record.color)) throw new ObjectValidationError(`${at}.color is invalid.`);
    return {
      id: record.id,
      shape: record.shape,
      xMeters: finite(record.xMeters, `${at}.xMeters`, -100, 100),
      yMeters: finite(record.yMeters, `${at}.yMeters`, -100, 100),
      zMeters: finite(record.zMeters, `${at}.zMeters`, -100, 100),
      widthMeters: finite(record.widthMeters, `${at}.widthMeters`, 0.001, 100),
      heightMeters: finite(record.heightMeters, `${at}.heightMeters`, 0.001, 100),
      depthMeters: finite(record.depthMeters, `${at}.depthMeters`, 0.001, 100),
      color: record.color,
    };
  });
}

export function validateObjectDefinition(value: unknown): ObjectDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ObjectValidationError('Object must be an object.');
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id.trim() || record.id.length > 200) throw new ObjectValidationError('Object id is invalid.');
  if (typeof record.name !== 'string' || !record.name.trim() || record.name.length > 200) throw new ObjectValidationError('Object name is invalid.');
  const now = new Date().toISOString();
  const validDate = (date: unknown): string => (typeof date === 'string' && !Number.isNaN(Date.parse(date)) ? date : now);
  return {
    id: record.id,
    name: record.name.trim(),
    parts: validateParts(record.parts),
    createdAt: validDate(record.createdAt),
    modifiedAt: validDate(record.modifiedAt),
  };
}

export interface ObjectFile {
  format: typeof OBJECT_FILE_FORMAT;
  formatVersion: number;
  exportedAt: string;
  applicationVersion: string;
  objects: ObjectDefinition[];
}

export function serializeObjects(objects: ObjectDefinition[]): string {
  const file: ObjectFile = {
    format: OBJECT_FILE_FORMAT,
    formatVersion: OBJECT_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    applicationVersion: APPLICATION_VERSION,
    objects: objects.map(validateObjectDefinition),
  };
  return JSON.stringify(file, null, 2);
}

export function parseObjectFile(text: string): ObjectDefinition[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ObjectValidationError('The selected file is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ObjectValidationError('The object file must contain an object.');
  const file = parsed as Record<string, unknown>;
  if (file.format !== OBJECT_FILE_FORMAT) throw new ObjectValidationError('This is not a SiteMeasure object file.');
  if (file.formatVersion !== OBJECT_FILE_VERSION) throw new ObjectValidationError('Unsupported object file version.');
  if (!Array.isArray(file.objects) || file.objects.length < 1 || file.objects.length > 500) throw new ObjectValidationError('The object file contains no objects.');
  return file.objects.map(validateObjectDefinition);
}

export function objectFilename(objects: ObjectDefinition[]): string {
  const base = objects.length === 1 ? objects[0].name : 'objects';
  const safe = base.normalize('NFKD').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'objects';
  return `${safe}.sitemeasure-object.json`;
}
