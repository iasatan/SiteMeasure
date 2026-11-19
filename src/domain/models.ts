export const SCHEMA_VERSION = 1 as const;
export const APPLICATION_VERSION = '0.1.0';

export type Unit = 'metric' | 'imperial';
export type ProjectStatus = 'active' | 'complete' | 'archived';

export interface Point {
  xMeters: number;
  yMeters: number;
}

export interface Wall {
  id: string;
  start: Point;
  end: Point;
  thicknessMeters: number;
  lengthMeters?: number;
  locked?: boolean;
}

export interface Door {
  id: string;
  wallId: string;
  offsetMeters: number;
  widthMeters: number;
}

export interface Window {
  id: string;
  wallId: string;
  offsetMeters: number;
  widthMeters: number;
}

export interface Measurement {
  id: string;
  targetType: 'wall' | 'room' | 'other';
  targetId: string;
  valueMeters: number;
  capturedAt: string;
  source: 'manual' | 'bluetooth';
  deviceName?: string;
}

export interface Room {
  id: string;
  name: string;
  points: Point[];
  walls: Wall[];
  doors: Door[];
  windows: Window[];
  openings: never[];
  objects: never[];
  measurements: Measurement[];
  photos: never[];
  notes: string[];
}

export interface Floor {
  id: string;
  name: string;
  level: number;
  rooms: Room[];
}

export interface Building {
  id: string;
  name: string;
  floors: Floor[];
}

export interface Project {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  projectNumber: string;
  customer: string;
  address: string;
  description: string;
  status: ProjectStatus;
  tags: string[];
  createdAt: string;
  modifiedAt: string;
  preferredUnits: Unit;
  buildings: Building[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  projectNumber: string;
  customer: string;
  address: string;
  status: ProjectStatus;
  modifiedAt: string;
  floorCount: number;
  roomCount: number;
}

export interface StorageUsage {
  bytesUsed: number;
  quotaBytes: number | null;
  percentUsed: number | null;
}

export interface ProjectRepository {
  list(): ProjectSummary[];
  get(projectId: string): Project | null;
  save(project: Project): void;
  delete(projectId: string): void;
  duplicate(projectId: string): Project;
  getStorageUsage(): StorageUsage;
}

let fallbackIdCounter = 0;

export function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  fallbackIdCounter += 1;
  return `${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}`;
}

export function createRoom(name = 'Room 1'): Room {
  return {
    id: createId(),
    name,
    points: [],
    walls: [],
    doors: [],
    windows: [],
    openings: [],
    objects: [],
    measurements: [],
    photos: [],
    notes: [],
  };
}

export function createProject(name: string): Project {
  const now = new Date().toISOString();
  const floor: Floor = {
    id: createId(),
    name: 'Ground floor',
    level: 0,
    rooms: [createRoom()],
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    id: createId(),
    name: name.trim(),
    projectNumber: '',
    customer: '',
    address: '',
    description: '',
    status: 'active',
    tags: [],
    createdAt: now,
    modifiedAt: now,
    preferredUnits: 'metric',
    buildings: [{ id: createId(), name: 'Building 1', floors: [floor] }],
  };
}

export function summarizeProject(project: Project): ProjectSummary {
  const floors = project.buildings.flatMap((building) => building.floors);
  return {
    id: project.id,
    name: project.name,
    projectNumber: project.projectNumber,
    customer: project.customer,
    address: project.address,
    status: project.status,
    modifiedAt: project.modifiedAt,
    floorCount: floors.length,
    roomCount: floors.reduce((total, floor) => total + floor.rooms.length, 0),
  };
}
