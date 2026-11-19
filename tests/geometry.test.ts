import { describe, expect, it } from 'vitest';
import { createRoom } from '../src/domain/models';
import { distanceBetween, feetToMeters, metersToFeet, polygonArea, polygonIssues, polygonPerimeter, roomVolume, wallArea } from '../src/geometry';

const rectangle = [
  { xMeters: 0, yMeters: 0 },
  { xMeters: 5, yMeters: 0 },
  { xMeters: 5, yMeters: 4 },
  { xMeters: 0, yMeters: 4 },
];

describe('geometry', () => {
  it('calculates distance, area, perimeter, and volume', () => {
    expect(distanceBetween(rectangle[0], rectangle[1])).toBe(5);
    expect(polygonArea(rectangle)).toBe(20);
    expect(polygonPerimeter(rectangle)).toBe(18);
    const room = createRoom();
    room.points = rectangle;
    expect(roomVolume(room, 3)).toBe(60);
  });

  it('converts units reversibly', () => {
    expect(metersToFeet(1)).toBeCloseTo(3.280839895);
    expect(feetToMeters(metersToFeet(8))).toBeCloseTo(8);
  });

  it('detects invalid and self-intersecting polygons', () => {
    expect(polygonIssues([{ xMeters: 0, yMeters: 0 }, { xMeters: 1, yMeters: 0 }])).toContain('A room needs at least three vertices.');
    expect(polygonIssues([
      { xMeters: 0, yMeters: 0 },
      { xMeters: 2, yMeters: 2 },
      { xMeters: 0, yMeters: 2 },
      { xMeters: 2, yMeters: 0 },
    ])).toContain('The room boundary crosses itself.');
  });

  it('subtracts openings from wall area', () => {
    const walls = [
      { id: 'one', start: rectangle[0], end: rectangle[1], thicknessMeters: 0.1 },
      { id: 'two', start: rectangle[1], end: rectangle[2], thicknessMeters: 0.1 },
    ];
    expect(wallArea(walls, 2.5, 2)).toBe(20.5);
  });
});
