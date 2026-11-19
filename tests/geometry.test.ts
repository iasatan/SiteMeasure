import { describe, expect, it } from 'vitest';
import { createRoom } from '../src/domain/models';
import { cornerAngleDegrees, deriveOpeningSegments, distanceBetween, feetToMeters, metersToFeet, perpendicularPoint, polygonArea, polygonIssues, polygonPerimeter, roomVolume, setCornerAngle, wallArea } from '../src/geometry';

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

describe('right angles and opening segments', () => {
  const square = () => [[0, 0, 4, 0], [4, 0, 4, 3], [4, 3, 0, 3], [0, 3, 0, 0]].map(([sx, sy, ex, ey], index) => ({
    id: String(index), start: { xMeters: sx, yMeters: sy }, end: { xMeters: ex, yMeters: ey }, thicknessMeters: 0.15,
  }));

  it('measures 90 degree corners and changes them while keeping the loop closed', () => {
    const walls = square();
    expect(cornerAngleDegrees(walls, 0)).toBeCloseTo(90);
    expect(setCornerAngle(walls, 0, 60)).toBe(true);
    expect(cornerAngleDegrees(walls, 0)).toBeCloseTo(60);
    expect(distanceBetween(walls[1].start, walls[1].end)).toBeCloseTo(3);
    expect(distanceBetween(walls[1].end, walls[2].start)).toBeCloseTo(0);
  });

  it('projects points perpendicular to the previous segment', () => {
    const point = perpendicularPoint({ xMeters: 0, yMeters: 0 }, { xMeters: 4, yMeters: 0 }, { xMeters: 4.7, yMeters: 2 });
    expect(point.xMeters).toBeCloseTo(4);
    expect(point.yMeters).toBeCloseTo(2);
  });

  it('derives the missing wall segment', () => {
    const base = { total: 5, before: 1, width: 0.9, after: 0 };
    expect(deriveOpeningSegments(base, 'after').after).toBeCloseTo(3.1);
    expect(deriveOpeningSegments({ ...base, after: 3.1, total: 0 }, 'total').total).toBeCloseTo(5);
    expect(deriveOpeningSegments({ ...base, width: 0 }, 'width').width).toBeCloseTo(4);
  });
});
