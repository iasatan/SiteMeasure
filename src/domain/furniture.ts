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
  /** Part this one is attached to; it follows when the parent is moved or resized. */
  parentId?: string;
}

export interface ObjectDefinition {
  id: string;
  name: string;
  layer?: 'technician' | 'designer';
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

import { OBJECT_PRESETS } from './furniture-templates';

export { OBJECT_PRESETS, type ObjectPreset } from './furniture-templates';

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
  const parts = value.map((raw, index) => {
    const at = `${path}[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ObjectValidationError(`${at} must be an object.`);
    const record = raw as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id.trim() || record.id.length > 200) throw new ObjectValidationError(`${at}.id is invalid.`);
    if (record.shape !== 'box' && record.shape !== 'cylinder') throw new ObjectValidationError(`${at}.shape is invalid.`);
    if (typeof record.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(record.color)) throw new ObjectValidationError(`${at}.color is invalid.`);
    if (record.parentId !== undefined && (typeof record.parentId !== 'string' || record.parentId.length > 200)) throw new ObjectValidationError(`${at}.parentId is invalid.`);
    const part: ObjectPart = {
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
    if (typeof record.parentId === 'string') part.parentId = record.parentId;
    return part;
  });
  const ids = new Set(parts.map((part) => part.id));
  if (ids.size !== parts.length) throw new ObjectValidationError(`${path} contains duplicate part ids.`);
  for (const part of parts) {
    if (part.parentId !== undefined && (!ids.has(part.parentId) || part.parentId === part.id)) delete part.parentId;
  }
  // Break any attachment cycles so propagation always terminates.
  for (const part of parts) {
    const seen = new Set<string>([part.id]);
    let current: ObjectPart | undefined = part;
    while (current?.parentId !== undefined) {
      if (seen.has(current.parentId)) {
        delete current.parentId;
        break;
      }
      seen.add(current.parentId);
      current = parts.find((candidate) => candidate.id === current?.parentId);
    }
  }
  return parts;
}

export type PartGeometry = Partial<Pick<ObjectPart, 'xMeters' | 'yMeters' | 'zMeters' | 'widthMeters' | 'heightMeters' | 'depthMeters'>>;

/** Keeps a child's offset along one axis: proportional while inside the parent's extent, a fixed gap from the face when outside it. */
function reanchor(child: number, oldCenter: number, oldHalf: number, newCenter: number, newHalf: number): number {
  const offset = child - oldCenter;
  const distance = Math.abs(offset);
  if (oldHalf > 0 && distance <= oldHalf) return newCenter + offset * (newHalf / oldHalf);
  return newCenter + (Math.sign(offset) || 1) * (newHalf + distance - oldHalf);
}

function followParent(parts: ObjectPart[], before: ObjectPart, after: ObjectPart, visited: Set<string>): void {
  for (const child of parts) {
    if (child.parentId !== after.id || visited.has(child.id)) continue;
    visited.add(child.id);
    const childBefore = { ...child };
    child.xMeters = reanchor(child.xMeters, before.xMeters, before.widthMeters / 2, after.xMeters, after.widthMeters / 2);
    child.yMeters = reanchor(child.yMeters, before.yMeters, before.heightMeters / 2, after.yMeters, after.heightMeters / 2);
    child.zMeters = reanchor(child.zMeters, before.zMeters, before.depthMeters / 2, after.zMeters, after.depthMeters / 2);
    followParent(parts, childBefore, child, visited);
  }
}

/** Moves or resizes a part; everything attached to it (directly or indirectly) stays stuck to it. */
export function applyPartChange(parts: ObjectPart[], id: string, changes: PartGeometry): void {
  const part = parts.find((candidate) => candidate.id === id);
  if (!part) return;
  const before = { ...part };
  Object.assign(part, changes);
  followParent(parts, before, part, new Set([id]));
}

/** Scales the whole object to new overall dimensions; parts keep their relative positions so joints stay closed. */
export function scaleParts(parts: ObjectPart[], size: { widthMeters?: number; heightMeters?: number; depthMeters?: number }): void {
  const bounds = partBounds(parts);
  const fx = size.widthMeters && bounds.widthMeters > 0 ? size.widthMeters / bounds.widthMeters : 1;
  const fy = size.heightMeters && bounds.heightMeters > 0 ? size.heightMeters / bounds.heightMeters : 1;
  const fz = size.depthMeters && bounds.depthMeters > 0 ? size.depthMeters / bounds.depthMeters : 1;
  for (const part of parts) {
    part.xMeters = bounds.min.x + (part.xMeters - bounds.min.x) * fx;
    part.yMeters = bounds.min.y + (part.yMeters - bounds.min.y) * fy;
    part.zMeters = bounds.min.z + (part.zMeters - bounds.min.z) * fz;
    part.widthMeters *= fx;
    part.heightMeters *= fy;
    part.depthMeters *= fz;
  }
}

/** Rounds to the nearest multiple of step; a non-positive step disables snapping. */
export function snapValue(value: number, step: number): number {
  if (!(step > 0)) return value;
  return Math.round(Math.round(value / step) * step * 1e6) / 1e6;
}

/** Moves the whole object so its lowest point rests on y = 0 and it is centred on x/z. */
export function groundAndCenter(parts: ObjectPart[]): void {
  if (!parts.length) return;
  const bounds = partBounds(parts);
  const dx = -(bounds.min.x + bounds.max.x) / 2;
  const dz = -(bounds.min.z + bounds.max.z) / 2;
  const dy = -bounds.min.y;
  for (const part of parts) {
    part.xMeters += dx;
    part.yMeters += dy;
    part.zMeters += dz;
  }
}

/** Mirrors every part across the object's centre plane on the given horizontal axis. */
export function mirrorParts(parts: ObjectPart[], axis: 'x' | 'z'): void {
  const bounds = partBounds(parts);
  const key = axis === 'x' ? 'xMeters' : 'zMeters';
  const centre = axis === 'x' ? (bounds.min.x + bounds.max.x) / 2 : (bounds.min.z + bounds.max.z) / 2;
  for (const part of parts) part[key] = 2 * centre - part[key];
}

/** Ids of every part attached, directly or indirectly, to the given part. */
export function descendantIds(parts: ObjectPart[], id: string): Set<string> {
  const result = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const current = queue.pop();
    for (const part of parts) {
      if (part.parentId === current && !result.has(part.id)) {
        result.add(part.id);
        queue.push(part.id);
      }
    }
  }
  return result;
}

/** Copies parts with fresh ids, preserving attachments. */
export function cloneParts(parts: ObjectPart[]): ObjectPart[] {
  const ids = new Map(parts.map((part) => [part.id, createId()]));
  return parts.map((part) => {
    const copy: ObjectPart = { ...part, id: ids.get(part.id) ?? createId() };
    if (part.parentId !== undefined) copy.parentId = ids.get(part.parentId);
    return copy;
  });
}

export function validateObjectDefinition(value: unknown): ObjectDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ObjectValidationError('Object must be an object.');
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id.trim() || record.id.length > 200) throw new ObjectValidationError('Object id is invalid.');
  if (typeof record.name !== 'string' || !record.name.trim() || record.name.length > 200) throw new ObjectValidationError('Object name is invalid.');
  if (record.layer !== undefined && record.layer !== 'technician' && record.layer !== 'designer') throw new ObjectValidationError('Object layer is invalid.');
  const now = new Date().toISOString();
  const validDate = (date: unknown): string => (typeof date === 'string' && !Number.isNaN(Date.parse(date)) ? date : now);
  return {
    id: record.id,
    name: record.name.trim(),
    ...(record.layer ? { layer: record.layer as 'technician' | 'designer' } : {}),
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

/** Objects published through pull requests live in /objects and are bundled as templates. */
const PUBLISHED_OBJECT_FILES = import.meta.glob('../../objects/*.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

for (const [path, text] of Object.entries(PUBLISHED_OBJECT_FILES)) {
  try {
    for (const object of parseObjectFile(text)) {
      if (OBJECT_PRESETS.some((preset) => preset.label.toLowerCase() === object.name.toLowerCase())) continue;
      OBJECT_PRESETS.push({ label: object.name, category: 'Published', layer: object.layer ?? 'designer', build: () => cloneParts(object.parts) });
    }
  } catch (error) {
    console.warn(`Skipped published object file ${path}.`, error);
  }
}
