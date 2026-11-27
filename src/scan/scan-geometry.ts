import * as THREE from 'three';
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

export function buildScanGeometry(records: readonly ScanRecord[], mode: ScanMode): { geometry: THREE.BufferGeometry; count: number; triangles: number } {
  const points: ScanPoint[] = records.flatMap(({ distanceMeters, orientation }) => {
    const heading = orientation.compassDegrees;
    if (heading === null || !Number.isFinite(heading) || !Number.isFinite(orientation.levelBeta) || !Number.isFinite(distanceMeters) || distanceMeters <= 0) return [];
    return [{ heading: heading * Math.PI / 180, elevation: orientation.levelBeta * Math.PI / 180, distance: distanceMeters }];
  });
  const geometry = new THREE.BufferGeometry();
  if (!points.length) return { geometry, count: 0, triangles: 0 };

  const meanHeading = Math.atan2(points.reduce((sum, point) => sum + Math.sin(point.heading), 0), points.reduce((sum, point) => sum + Math.cos(point.heading), 0));
  const coordinates = points.map((point) => [Math.atan2(Math.sin(point.heading - meanHeading), Math.cos(point.heading - meanHeading)) * Math.cos(point.elevation), point.elevation] as [number, number]);
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
    const center = coordinates.reduce((sum, coordinate) => sum.add(new THREE.Vector2(...coordinate)), new THREE.Vector2()).divideScalar(coordinates.length);
    const sorted = coordinates.map((coordinate, index) => ({ index, point: new THREE.Vector2(...coordinate) }))
      .sort((left, right) => Math.atan2(left.point.y - center.y, left.point.x - center.x) - Math.atan2(right.point.y - center.y, right.point.x - center.x));
    const faces = THREE.ShapeUtils.triangulateShape(sorted.map(({ point }) => point), []);
    geometry.setIndex(faces.flatMap((face) => face.map((index) => sorted[index].index)));
    triangles = faces.length;
    if (triangles) geometry.computeVertexNormals();
  }
  geometry.computeBoundingBox();
  return { geometry, count: points.length, triangles };
}