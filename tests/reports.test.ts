import { describe, expect, it } from 'vitest';
import { createProject, createRoom } from '../src/domain/models';
import { csvCell, floorPlanSvg, measurementsCsv, printableReport } from '../src/reports/project-exports';
import { roomSlideshowHtml } from '../src/reports/room-visualization';

describe('project reports', () => {
  it('escapes CSV and neutralizes spreadsheet formulas', () => {
    expect(csvCell('A, B')).toBe('"A, B"');
    expect(csvCell('=1+1')).toBe("'=1+1");
  });

  it('exports measurements without executable project text', () => {
    const project = createProject('Job <script>');
    const room = project.buildings[0].floors[0].rooms[0];
    room.measurements.push({ id: 'm1', targetType: 'other', targetId: room.id, valueMeters: 2.5, capturedAt: '2026-01-01T00:00:00.000Z', source: 'manual' });
    expect(measurementsCsv(project)).toContain('Job <script>');
    expect(printableReport(project)).not.toContain('<script>');
    expect(printableReport(project)).toContain('&lt;script&gt;');
  });

  it('creates a standalone SVG for a room', () => {
    const project = createProject('Plan');
    const room = createRoom('Kitchen');
    room.points = [{ xMeters: 0, yMeters: 0 }, { xMeters: 4, yMeters: 0 }, { xMeters: 4, yMeters: 3 }];
    const svg = floorPlanSvg(project, room);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('<polygon');
  });

  it('creates a downloadable four-image 3D slideshow', () => {
    const photos = ['Front', 'Side', 'Rear', 'Plan'].map((label, index) => ({ label, dataUrl: `data:image/png;base64,image-${index}` }));
    const html = roomSlideshowHtml('House <script>', 'Kitchen & dining', photos);

    expect(html.match(/<figure class="slide/g)).toHaveLength(4);
    expect(html).toContain("document.querySelector('#previous')");
    expect(html).toContain("document.querySelector('#next')");
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('House &lt;script&gt;');
    expect(html).toContain('Kitchen &amp; dining');
  });
});
