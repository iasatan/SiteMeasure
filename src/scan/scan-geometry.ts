import * as THREE from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import type { ScanRecord } from './scan-records';

export type ScanMode = 'points' | 'path' | 'surface' | 'smooth';

interface ScanPoint {
  heading: number;
  elevation: number;
  distance: number;
}

function position(point: ScanPoint): THREE.Vector3 {
  const horizontal = point.distance * Math.cos(point.elevation);
  return new THREE.Vector3(horizontal * Math.sin(point.heading), point.distance * Math.sin(point.elevation), -horizontal * Math.cos(point.heading));
}

function triangulate(coordinates: readonly [number, number][]): number[] {
  const unique = new Map<string, { coordinate: [number, number]; index: number }>();
  coordinates.forEach((coordinate, index) => {
    const key = `${coordinate[0]},${coordinate[1]}`;
    if (!unique.has(key)) unique.set(key, { coordinate, index });
  });
  const entries = Array.from(unique.values());
  if (entries.length < 3) return [];
  const minX = Math.min(...entries.map(({ coordinate }) => coordinate[0]));
  const maxX = Math.max(...entries.map(({ coordinate }) => coordinate[0]));
  const minY = Math.min(...entries.map(({ coordinate }) => coordinate[1]));
  const maxY = Math.max(...entries.map(({ coordinate }) => coordinate[1]));
  const scale = Math.max(maxX - minX, maxY - minY);
  if (!scale) return [];
  const indices = new Map<THREE.Vector3, number>();
  const lifted = entries.map(({ coordinate, index }) => {
    const x = (coordinate[0] - (minX + maxX) / 2) / scale;
    const y = (coordinate[1] - (minY + maxY) / 2) / scale;
    const point = new THREE.Vector3(x, y, x * x + y * y);
    indices.set(point, index);
    return point;
  });
  for (const [x, y] of [[-16, -16], [16, -16], [0, 16]]) lifted.push(new THREE.Vector3(x, y, x * x + y * y));
  const hull = new ConvexHull().setFromPoints(lifted);
  return hull.faces.flatMap((face) => {
    if (face.normal.z >= -1e-12) return [];
    const vertices = [face.edge, face.edge.next, face.edge.next.next].map((edge) => indices.get(edge.head().point));
    return vertices.every((index) => index !== undefined) ? vertices as number[] : [];
  });
}

export function buildScanGeometry(records: readonly ScanRecord[], mode: ScanMode): { geometry: THREE.BufferGeometry; count: number; triangles: number } {
  const points: ScanPoint[] = records.flatMap(({ distanceMeters, orientation }) => {
    const heading = orientation.compassDegrees;
    if (heading === null || !Number.isFinite(heading) || !Number.isFinite(orientation.levelBeta) || !Number.isFinite(distanceMeters) || distanceMeters <= 0) return [];
    return [{ heading: heading * Math.PI / 180, elevation: orientation.levelBeta * Math.PI / 180, distance: distanceMeters }];
  });
  const geometry = new THREE.BufferGeometry();
  if (!points.length) return { geometry, count: 0, triangles: 0 };

  const meanHeading = Math.atan2(points.reduce((sum, point) => sum + Math.sin(point.heading), 0), points.reduce((sum, point) => sum + Math.cos(point.heading), 0));
  const meanElevation = points.reduce((sum, point) => sum + point.elevation, 0) / points.length;
  const coordinates = points.map((point) => [Math.atan2(Math.sin(point.heading - meanHeading), Math.cos(point.heading - meanHeading)) * Math.cos(meanElevation), point.elevation] as [number, number]);
  const positions = points.map((point, index) => {
    if (mode !== 'smooth') return position(point);
    let total = 0;
    let weights = 0;
    points.forEach((neighbor, neighborIndex) => {
      const separation = Math.hypot(coordinates[index][0] - coordinates[neighborIndex][0], coordinates[index][1] - coordinates[neighborIndex][1]);
      const weight = Math.exp(-((separation / (3 * Math.PI / 180)) ** 2));
      total += neighbor.distance * weight;
      weights += weight;
    });
    return position({ ...point, distance: total / weights });
  });
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions.flatMap((point) => point.toArray()), 3));
  let triangles = 0;
  if ((mode === 'surface' || mode === 'smooth') && points.length >= 3) {
    const indices = triangulate(coordinates);
    triangles = indices.length / 3;
    if (triangles) {
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
    }
  }
  geometry.computeBoundingBox();
  return { geometry, count: points.length, triangles };
}