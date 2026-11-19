import type { Point, Room, Wall } from './domain/models';

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

export function roomVolume(room: Room, ceilingHeightMeters = 2.7): number {
  return roomArea(room) * ceilingHeightMeters;
}

export function wallArea(walls: Wall[], heightMeters = 2.7, openingArea = 0): number {
  return Math.max(0, walls.reduce((sum, wall) => sum + wallLength(wall) * heightMeters, 0) - openingArea);
}

export function openingArea(walls: Wall[], room: Room): number {
  const lengths = new Map(walls.map((wall) => [wall.id, wallLength(wall)]));
  const openings = [...room.doors, ...room.windows];
  return openings.reduce((sum, opening) => sum + (lengths.has(opening.wallId) ? opening.widthMeters * 2.1 : 0), 0);
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
