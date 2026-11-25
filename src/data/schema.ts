import { validateParts } from '../domain/furniture';
import { SCHEMA_VERSION, type Project, type ProjectStatus, type Unit } from '../domain/models';

type JsonRecord = Record<string, unknown>;

export class ProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectValidationError';
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.hasOwn(record, key);
}

function expectRecord(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) throw new ProjectValidationError(`${path} must be an object.`);
  if (hasOwn(value, '__proto__') || hasOwn(value, 'prototype') || hasOwn(value, 'constructor')) {
    throw new ProjectValidationError(`${path} contains an unsafe key.`);
  }
  return value;
}

function expectString(value: unknown, path: string, allowEmpty = true): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > 10_000) {
    throw new ProjectValidationError(`${path} is invalid.`);
  }
  return value;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new ProjectValidationError(`${path} must be a bounded array.`);
  }
  return value;
}

function expectFinite(value: unknown, path: string, minimum = -1_000_000, maximum = 1_000_000): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ProjectValidationError(`${path} is outside the allowed range.`);
  }
  return value;
}

function expectIsoDate(value: unknown, path: string): string {
  const date = expectString(value, path, false);
  if (Number.isNaN(Date.parse(date))) throw new ProjectValidationError(`${path} must be an ISO date.`);
  return date;
}

function validatePoint(value: unknown, path: string): JsonRecord {
  const point = expectRecord(value, path);
  expectFinite(point.xMeters, `${path}.xMeters`);
  expectFinite(point.yMeters, `${path}.yMeters`);
  return point;
}

function validateRoom(value: unknown, path: string): void {
  const room = expectRecord(value, path);
  expectString(room.id, `${path}.id`, false);
  expectString(room.name, `${path}.name`, false);
  if (room.heightMeters !== undefined) expectFinite(room.heightMeters, `${path}.heightMeters`, 0.1, 100);
  expectArray(room.points, `${path}.points`).forEach((point, index) => validatePoint(point, `${path}.points[${index}]`));
  expectArray(room.walls, `${path}.walls`).forEach((wallValue, index) => {
    const wall = expectRecord(wallValue, `${path}.walls[${index}]`);
    expectString(wall.id, `${path}.walls[${index}].id`, false);
    validatePoint(wall.start, `${path}.walls[${index}].start`);
    validatePoint(wall.end, `${path}.walls[${index}].end`);
    expectFinite(wall.thicknessMeters, `${path}.walls[${index}].thicknessMeters`, 0, 10);
    if (wall.lengthMeters !== undefined) expectFinite(wall.lengthMeters, `${path}.walls[${index}].lengthMeters`, 0.001, 1_000_000);
    if (wall.locked !== undefined && typeof wall.locked !== 'boolean') throw new ProjectValidationError(`${path}.walls[${index}].locked is invalid.`);
  });
  for (const type of ['doors', 'windows'] as const) {
    expectArray(room[type], `${path}.${type}`).forEach((openingValue, index) => {
      const opening = expectRecord(openingValue, `${path}.${type}[${index}]`);
      expectString(opening.id, `${path}.${type}[${index}].id`, false);
      expectString(opening.wallId, `${path}.${type}[${index}].wallId`, false);
      if (opening.rightWallId !== undefined) expectString(opening.rightWallId, `${path}.${type}[${index}].rightWallId`, false);
      expectFinite(opening.offsetMeters, `${path}.${type}[${index}].offsetMeters`, 0, 1_000_000);
      expectFinite(opening.widthMeters, `${path}.${type}[${index}].widthMeters`, 0.001, 1_000_000);
      if (opening.heightMeters !== undefined) expectFinite(opening.heightMeters, `${path}.${type}[${index}].heightMeters`, 0.01, 100);
    });
  }
  expectArray(room.measurements, `${path}.measurements`).forEach((measurementValue, index) => {
    const measurement = expectRecord(measurementValue, `${path}.measurements[${index}]`);
    expectString(measurement.id, `${path}.measurements[${index}].id`, false);
    expectString(measurement.targetId, `${path}.measurements[${index}].targetId`, false);
    if (!['wall', 'room', 'other'].includes(String(measurement.targetType))) throw new ProjectValidationError(`${path}.measurements[${index}].targetType is invalid.`);
    if (!['manual', 'bluetooth'].includes(String(measurement.source))) throw new ProjectValidationError(`${path}.measurements[${index}].source is invalid.`);
    expectFinite(measurement.valueMeters, `${path}.measurements[${index}].valueMeters`, 0.001, 1_000_000);
    expectIsoDate(measurement.capturedAt, `${path}.measurements[${index}].capturedAt`);
    if (measurement.deviceName !== undefined) expectString(measurement.deviceName, `${path}.measurements[${index}].deviceName`, false);
  });
  expectArray(room.photos, `${path}.photos`).forEach((photoValue, index) => {
    const photoPath = `${path}.photos[${index}]`;
    const photo = expectRecord(photoValue, photoPath);
    expectString(photo.id, `${photoPath}.id`, false);
    expectString(photo.title, `${photoPath}.title`);
    expectString(photo.notes, `${photoPath}.notes`);
    if (typeof photo.dataUrl !== 'string' || photo.dataUrl.length > 8 * 1024 * 1024) throw new ProjectValidationError(`${photoPath}.dataUrl is invalid or too large.`);
    if (!['image/jpeg', 'image/webp'].includes(String(photo.mimeType))) throw new ProjectValidationError(`${photoPath}.mimeType is invalid.`);
    const expectedPrefix = `data:${String(photo.mimeType)};base64,`;
    if (!String(photo.dataUrl).startsWith(expectedPrefix)) throw new ProjectValidationError(`${photoPath}.dataUrl does not match its MIME type.`);
    expectFinite(photo.width, `${photoPath}.width`, 1, 10_000);
    expectFinite(photo.height, `${photoPath}.height`, 1, 10_000);
    expectFinite(photo.sizeBytes, `${photoPath}.sizeBytes`, 1, 10 * 1024 * 1024);
    expectIsoDate(photo.capturedAt, `${photoPath}.capturedAt`);
    expectArray(photo.annotations, `${photoPath}.annotations`).forEach((annotationValue, annotationIndex) => {
      const annotationPath = `${photoPath}.annotations[${annotationIndex}]`;
      const annotation = expectRecord(annotationValue, annotationPath);
      expectString(annotation.id, `${annotationPath}.id`, false);
      if (!['arrow', 'rectangle', 'circle', 'text'].includes(String(annotation.type))) throw new ProjectValidationError(`${annotationPath}.type is invalid.`);
      expectFinite(annotation.x, `${annotationPath}.x`, 0, 1);
      expectFinite(annotation.y, `${annotationPath}.y`, 0, 1);
      for (const coordinate of ['endX', 'endY'] as const) {
        if (annotation[coordinate] !== undefined) expectFinite(annotation[coordinate], `${annotationPath}.${coordinate}`, 0, 1);
      }
      for (const dimension of ['width', 'height'] as const) {
        if (annotation[dimension] !== undefined) expectFinite(annotation[dimension], `${annotationPath}.${dimension}`, 0, 1);
      }
      if (annotation.text !== undefined) expectString(annotation.text, `${annotationPath}.text`);
      if (typeof annotation.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(annotation.color)) throw new ProjectValidationError(`${annotationPath}.color is invalid.`);
    });
  });
  expectArray(room.openings, `${path}.openings`);
  expectArray(room.objects, `${path}.objects`).forEach((objectValue, index) => {
    const object = expectRecord(objectValue, `${path}.objects[${index}]`);
    expectString(object.id, `${path}.objects[${index}].id`, false);
    expectString(object.name, `${path}.objects[${index}].name`, false);
    if (object.layer !== undefined && object.layer !== 'technician' && object.layer !== 'designer') throw new ProjectValidationError(`${path}.objects[${index}].layer is invalid.`);
    for (const key of ['widthMeters', 'depthMeters', 'heightMeters']) expectFinite(object[key], `${path}.objects[${index}].${key}`, 0.001, 1000);
    for (const key of ['xMeters', 'yMeters']) if (object[key] !== undefined) expectFinite(object[key], `${path}.objects[${index}].${key}`, -100000, 100000);
    if (object.elevationMeters !== undefined) expectFinite(object.elevationMeters, `${path}.objects[${index}].elevationMeters`, 0, 100000);
    if (object.rotationRadians !== undefined) expectFinite(object.rotationRadians, `${path}.objects[${index}].rotationRadians`);
    if (object.wallMount !== undefined) {
      const mount = expectRecord(object.wallMount, `${path}.objects[${index}].wallMount`);
      expectString(mount.wallId, `${path}.objects[${index}].wallMount.wallId`, false);
      expectFinite(mount.offsetMeters, `${path}.objects[${index}].wallMount.offsetMeters`, 0, 100000);
      expectFinite(mount.elevationMeters, `${path}.objects[${index}].wallMount.elevationMeters`, 0, 100000);
    }
    if (object.parts !== undefined) {
      try {
        validateParts(object.parts, `${path}.objects[${index}].parts`);
      } catch (error) {
        throw new ProjectValidationError(error instanceof Error ? error.message : `${path}.objects[${index}].parts is invalid.`);
      }
    }
  });
  expectArray(room.notes, `${path}.notes`).forEach((note, index) => expectString(note, `${path}.notes[${index}]`));
}

function validateCurrentProject(value: unknown): Project {
  const project = expectRecord(value, 'project');
  if (project.schemaVersion !== SCHEMA_VERSION) {
    throw new ProjectValidationError(`Unsupported project schema version ${String(project.schemaVersion)}.`);
  }

  expectString(project.id, 'project.id', false);
  expectString(project.name, 'project.name', false);
  expectString(project.projectNumber, 'project.projectNumber');
  expectString(project.customer, 'project.customer');
  expectString(project.address, 'project.address');
  expectString(project.description, 'project.description');
  expectIsoDate(project.createdAt, 'project.createdAt');
  expectIsoDate(project.modifiedAt, 'project.modifiedAt');
  expectArray(project.tags, 'project.tags').forEach((tag, index) => expectString(tag, `project.tags[${index}]`, false));

  if (!['active', 'complete', 'archived'].includes(String(project.status))) {
    throw new ProjectValidationError('project.status is invalid.');
  }
  if (!['metric', 'imperial'].includes(String(project.preferredUnits))) {
    throw new ProjectValidationError('project.preferredUnits is invalid.');
  }

  expectArray(project.buildings, 'project.buildings').forEach((buildingValue, buildingIndex) => {
    const buildingPath = `project.buildings[${buildingIndex}]`;
    const building = expectRecord(buildingValue, buildingPath);
    expectString(building.id, `${buildingPath}.id`, false);
    expectString(building.name, `${buildingPath}.name`, false);
    expectArray(building.floors, `${buildingPath}.floors`).forEach((floorValue, floorIndex) => {
      const floorPath = `${buildingPath}.floors[${floorIndex}]`;
      const floor = expectRecord(floorValue, floorPath);
      expectString(floor.id, `${floorPath}.id`, false);
      expectString(floor.name, `${floorPath}.name`, false);
      expectFinite(floor.level, `${floorPath}.level`, -100, 100);
      expectArray(floor.rooms, `${floorPath}.rooms`).forEach((room, roomIndex) => validateRoom(room, `${floorPath}.rooms[${roomIndex}]`));
    });
  });

  project.status = project.status as ProjectStatus;
  project.preferredUnits = project.preferredUnits as Unit;
  return project as unknown as Project;
}

export function parseProjectJson(text: string): Project {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProjectValidationError('The file is not valid JSON.');
  }
  return validateProject(parsed);
}

export function validateProject(value: unknown): Project {
  return validateCurrentProject(structuredClone(value));
}

export function migrateProject(value: unknown): Project | null {
  if (isRecord(value) && (value.schemaVersion === 0 || value.schemaVersion === undefined)) {
    return validateCurrentProject({ ...value, schemaVersion: SCHEMA_VERSION });
  }
  return null;
}
