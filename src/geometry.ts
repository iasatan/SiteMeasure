import { DEFAULT_DOOR_HEIGHT_METERS, DEFAULT_ROOM_HEIGHT_METERS, DEFAULT_WINDOW_HEIGHT_METERS, type Point, type Room, type Wall } from './domain/models';

const EPSILON = 1e-7;

export function distanceBetween(left: Point, right: Point): number {
  return Math.hypot(right.xMeters - left.xMeters, right.yMeters - left.yMeters);
}

export function polygonArea(points: Point[]): number {
  if (points.length < 3) return 0;
  const doubled = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.xMeters * next.yMeters - next.xMeters * point.yMeters;
  }, 0);
  return Math.abs(doubled) / 2;
}

export function polygonPerimeter(points: Point[]): number {
  if (points.length < 2) return 0;
  return points.reduce((sum, point, index) => sum + distanceBetween(point, points[(index + 1) % points.length]), 0);
}

export function roomArea(room: Room): number {
  return polygonArea(room.points);
}

export function wallLength(wall: Wall): number {
  return wall.lengthMeters ?? distanceBetween(wall.start, wall.end);
}

export function roomHeight(room: Room): number {
  return room.heightMeters ?? DEFAULT_ROOM_HEIGHT_METERS;
}

export function roomVolume(room: Room, ceilingHeightMeters = roomHeight(room)): number {
  return roomArea(room) * ceilingHeightMeters;
}

export function wallArea(walls: Wall[], heightMeters = DEFAULT_ROOM_HEIGHT_METERS, openingArea = 0): number {
  return Math.max(0, walls.reduce((sum, wall) => sum + wallLength(wall) * heightMeters, 0) - openingArea);
}

export function openingArea(walls: Wall[], room: Room): number {
  const lengths = new Map(walls.map((wall) => [wall.id, wallLength(wall)]));
  const openings = [
    ...room.doors.map((opening) => ({ opening, height: opening.heightMeters ?? DEFAULT_DOOR_HEIGHT_METERS })),
    ...room.windows.map((opening) => ({ opening, height: opening.heightMeters ?? DEFAULT_WINDOW_HEIGHT_METERS })),
  ];
  return openings.reduce((sum, { opening, height }) => sum + (lengths.has(opening.wallId) && !opening.rightWallId ? opening.widthMeters * height : 0), 0);
}

export function metersToFeet(meters: number): number {
  return meters * 3.280839895;
}

export function feetToMeters(feet: number): number {
  return feet / 3.280839895;
}

export function formatLength(meters: number, preferredUnits: 'metric' | 'imperial'): string {
  if (preferredUnits === 'imperial') return `${metersToFeet(meters).toFixed(2)} ft`;
  if (meters < 1) return `${Math.round(meters * 1000)} mm`;
  return `${meters.toFixed(2)} m`;
}

export function polygonIssues(points: Point[]): string[] {
  const issues: string[] = [];
  if (points.length < 3) return ['A room needs at least three vertices.'];
  for (let index = 0; index < points.length; index += 1) {
    if (distanceBetween(points[index], points[(index + 1) % points.length]) <= EPSILON) {
      issues.push('The room contains a zero-length edge.');
    }
  }
  if (polygonSelfIntersects(points)) issues.push('The room boundary crosses itself.');
  if (polygonArea(points) <= EPSILON) issues.push('The room has no measurable area.');
  return [...new Set(issues)];
}

export function polygonSelfIntersects(points: Point[]): boolean {
  for (let first = 0; first < points.length; first += 1) {
    const firstEnd = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      const secondEnd = (second + 1) % points.length;
      if (first === second || firstEnd === second || first === secondEnd || firstEnd === secondEnd) continue;
      if (segmentsIntersect(points[first], points[firstEnd], points[second], points[secondEnd])) return true;
    }
  }
  return false;
}

export function nearestPointOnSegment(point: Point, start: Point, end: Point): Point {
  const dx = end.xMeters - start.xMeters;
  const dy = end.yMeters - start.yMeters;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= EPSILON) return { ...start };
  const projection = ((point.xMeters - start.xMeters) * dx + (point.yMeters - start.yMeters) * dy) / lengthSquared;
  const ratio = Math.max(0, Math.min(1, projection));
  return { xMeters: start.xMeters + dx * ratio, yMeters: start.yMeters + dy * ratio };
}

export function snapPoint(point: Point, gridMeters = 0.1, targets: Point[] = []): Point {
  const nearTarget = targets.find((target) => distanceBetween(point, target) <= gridMeters * 0.9);
  if (nearTarget) return { ...nearTarget };
  return {
    xMeters: Math.round(point.xMeters / gridMeters) * gridMeters,
    yMeters: Math.round(point.yMeters / gridMeters) * gridMeters,
  };
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const orientation = (p: Point, q: Point, r: Point) => (q.xMeters - p.xMeters) * (r.yMeters - p.yMeters) - (q.yMeters - p.yMeters) * (r.xMeters - p.xMeters);
  const onSegment = (p: Point, q: Point, r: Point) => q.xMeters <= Math.max(p.xMeters, r.xMeters) + EPSILON && q.xMeters + EPSILON >= Math.min(p.xMeters, r.xMeters) && q.yMeters <= Math.max(p.yMeters, r.yMeters) + EPSILON && q.yMeters + EPSILON >= Math.min(p.yMeters, r.yMeters);
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON)) && ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON))) return true;
  return (Math.abs(abC) <= EPSILON && onSegment(a, c, b)) || (Math.abs(abD) <= EPSILON && onSegment(a, d, b)) || (Math.abs(cdA) <= EPSILON && onSegment(c, a, d)) || (Math.abs(cdB) <= EPSILON && onSegment(c, b, d));
}

export type OpeningSegmentKey = 'total' | 'before' | 'width' | 'after';
export type OpeningSegments = Record<OpeningSegmentKey, number>;

/** A wall with an opening splits into before + width + after = total; derive the one segment that was not given. */
export function deriveOpeningSegments(values: OpeningSegments, derived: OpeningSegmentKey): OpeningSegments {
  const result = { ...values };
  if (derived === 'total') result.total = values.before + values.width + values.after;
  else if (derived === 'before') result.before = values.total - values.width - values.after;
  else if (derived === 'width') result.width = values.total - values.before - values.after;
  else result.after = values.total - values.before - values.width;
  return result;
}

/** Projects the pointer onto the line through `from` that is perpendicular to the segment `previous -> from`. */
export function perpendicularPoint(previous: Point, from: Point, pointer: Point): Point {
  const dx = from.xMeters - previous.xMeters;
  const dy = from.yMeters - previous.yMeters;
  const length = Math.hypot(dx, dy);
  if (length <= EPSILON) return pointer;
  const nx = -dy / length;
  const ny = dx / length;
  const distance = (pointer.xMeters - from.xMeters) * nx + (pointer.yMeters - from.yMeters) * ny;
  return { xMeters: from.xMeters + nx * distance, yMeters: from.yMeters + ny * distance };
}

function signedArea(points: Point[]): number {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.xMeters * next.yMeters - next.xMeters * point.yMeters;
  }, 0);
}

function isClosedLoop(walls: Wall[]): boolean {
  return walls.length >= 3 && walls.every((wall, index) => distanceBetween(wall.end, walls[(index + 1) % walls.length].start) < 0.05);
}

/** Interior angle in degrees at the end of walls[index] (between it and the next wall), or null when the walls are not a closed loop. */
export function cornerAngleDegrees(walls: Wall[], index: number): number | null {
  if (!isClosedLoop(walls)) return null;
  const wall = walls[index];
  const next = walls[(index + 1) % walls.length];
  const orientation = Math.sign(signedArea(walls.map((candidate) => candidate.start))) || 1;
  const vertex = wall.end;
  const back = Math.atan2(wall.start.yMeters - vertex.yMeters, wall.start.xMeters - vertex.xMeters);
  const forward = Math.atan2(next.end.yMeters - vertex.yMeters, next.end.xMeters - vertex.xMeters);
  const turn = (orientation * (back - forward) + 4 * Math.PI) % (2 * Math.PI);
  return (turn * 180) / Math.PI;
}

/** Rotates the next wall around the shared corner so the interior angle becomes `degrees`; the wall lengths are kept. Returns false when not possible. */
export function setCornerAngle(walls: Wall[], index: number, degrees: number): boolean {
  if (!isClosedLoop(walls) || !(degrees > 0 && degrees < 360)) return false;
  const wall = walls[index];
  const next = walls[(index + 1) % walls.length];
  const following = walls[(index + 2) % walls.length];
  const orientation = Math.sign(signedArea(walls.map((candidate) => candidate.start))) || 1;
  const vertex = wall.end;
  const back = Math.atan2(wall.start.yMeters - vertex.yMeters, wall.start.xMeters - vertex.xMeters);
  const forward = back - orientation * (degrees * Math.PI) / 180;
  const length = distanceBetween(next.start, next.end);
  next.end = { xMeters: vertex.xMeters + Math.cos(forward) * length, yMeters: vertex.yMeters + Math.sin(forward) * length };
  delete next.lengthMeters;
  if (following !== wall && following !== next) following.start = { ...next.end };
  return true;
}
