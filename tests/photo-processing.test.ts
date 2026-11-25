import { describe, expect, it } from 'vitest';
import { validateProject } from '../src/data/schema';
import { remapProjectIds } from '../src/data/local-storage-repository';
import { createProject } from '../src/domain/models';
import { resizedDimensions } from '../src/photos/photo-processing';
import { renderPhotoAnnotations } from '../src/photos/photo-annotations';

function projectWithPhoto() {
  const project = createProject('Photo project');
  project.buildings[0].floors[0].rooms[0].photos.push({
    id: 'photo-1', title: 'Wall', notes: 'Check crack', dataUrl: 'data:image/jpeg;base64,AAAA', mimeType: 'image/jpeg',
    width: 1200, height: 800, sizeBytes: 20_000, capturedAt: '2026-01-01T00:00:00.000Z',
    annotations: [{ id: 'annotation-1', type: 'arrow', x: 0.1, y: 0.2, endX: 0.5, endY: 0.6, color: '#e85d3f' }],
  });
  return project;
}

describe('photo processing', () => {
  it('preserves aspect ratio below the maximum dimension', () => {
    expect(resizedDimensions(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(resizedDimensions(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });

  it('rejects undecodable dimensions', () => {
    expect(() => resizedDimensions(0, 400, 1600)).toThrow('invalid dimensions');
  });

  it('validates compressed photos and rejects MIME mismatches', () => {
    const project = projectWithPhoto();
    expect(() => validateProject(project)).not.toThrow();
    project.buildings[0].floors[0].rooms[0].photos[0].dataUrl = 'data:image/png;base64,AAAA';
    expect(() => validateProject(project)).toThrow('does not match its MIME type');
  });

  it('remaps photo and annotation IDs when projects are copied', () => {
    const copy = remapProjectIds(projectWithPhoto());
    const photo = copy.buildings[0].floors[0].rooms[0].photos[0];
    expect(photo.id).not.toBe('photo-1');
    expect(photo.annotations[0].id).not.toBe('annotation-1');
  });

  it('validates and renders measured annotation dimensions', () => {
    const project = projectWithPhoto();
    const annotation = project.buildings[0].floors[0].rooms[0].photos[0].annotations[0];
    annotation.lengthMeters = 2;
    expect(validateProject(project).buildings[0].floors[0].rooms[0].photos[0].annotations[0].lengthMeters).toBe(2);
    const image = document.createElement('img');
    Object.defineProperties(image, { naturalWidth: { value: 1200 }, naturalHeight: { value: 800 } });
    const overlay = renderPhotoAnnotations(image, [annotation], 'imperial', annotation.id);
    expect(overlay.textContent).toContain('6.56 ft');
    expect(overlay.querySelector('.annotation-selected')).not.toBeNull();
    annotation.lengthMeters = -1;
    expect(() => validateProject(project)).toThrow('lengthMeters');
  });
});
