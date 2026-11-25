import type { PhotoAnnotation } from '../domain/models';
import { formatLength } from '../geometry';

export function renderPhotoAnnotations(image: HTMLImageElement, annotations: readonly PhotoAnnotation[], units: 'metric' | 'imperial' = 'metric', selectedId?: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('photo-annotations');
  svg.setAttribute('viewBox', `0 0 ${image.naturalWidth || 1} ${image.naturalHeight || 1}`);
  svg.setAttribute('aria-hidden', 'true');
  for (const annotation of annotations) {
    const shape = annotationElement(annotation, image.naturalWidth, image.naturalHeight);
    if (annotation.id === selectedId) shape.classList.add('annotation-selected');
    svg.append(shape);
    const dimensions = [
      annotation.lengthMeters === undefined ? '' : `L ${formatLength(annotation.lengthMeters, units)}`,
      annotation.widthMeters === undefined ? '' : `W ${formatLength(annotation.widthMeters, units)}`,
      annotation.heightMeters === undefined ? '' : `H ${formatLength(annotation.heightMeters, units)}`,
    ].filter(Boolean);
    if (dimensions.length) {
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String(Math.min(annotation.x, annotation.endX ?? annotation.x) * image.naturalWidth));
      label.setAttribute('y', String(Math.max(24, Math.min(annotation.y, annotation.endY ?? annotation.y) * image.naturalHeight - 8)));
      label.setAttribute('fill', annotation.color);
      label.classList.add('photo-annotation-text');
      label.textContent = dimensions.join('  ');
      svg.append(label);
    }
  }
  return svg;
}

export function normalizedPoint(image: HTMLImageElement, clientX: number, clientY: number): { x: number; y: number } {
  const bounds = image.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, (clientY - bounds.top) / bounds.height)),
  };
}

function annotationElement(annotation: PhotoAnnotation, width: number, height: number): SVGElement {
  const x = annotation.x * width;
  const y = annotation.y * height;
  const endX = (annotation.endX ?? annotation.x) * width;
  const endY = (annotation.endY ?? annotation.y) * height;
  if (annotation.type === 'text') {
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', String(x));
    text.setAttribute('y', String(y));
    text.setAttribute('fill', annotation.color);
    text.classList.add('photo-annotation-text');
    text.textContent = annotation.text ?? '';
    return text;
  }
  if (annotation.type === 'circle') {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
    circle.setAttribute('cx', String((x + endX) / 2));
    circle.setAttribute('cy', String((y + endY) / 2));
    circle.setAttribute('rx', String(Math.abs(endX - x) / 2));
    circle.setAttribute('ry', String(Math.abs(endY - y) / 2));
    circle.classList.add('photo-annotation-shape');
    circle.setAttribute('stroke', annotation.color);
    return circle;
  }
  if (annotation.type === 'rectangle') {
    const rectangle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rectangle.setAttribute('x', String(Math.min(x, endX)));
    rectangle.setAttribute('y', String(Math.min(y, endY)));
    rectangle.setAttribute('width', String(Math.abs(endX - x)));
    rectangle.setAttribute('height', String(Math.abs(endY - y)));
    rectangle.classList.add('photo-annotation-shape');
    rectangle.setAttribute('stroke', annotation.color);
    return rectangle;
  }
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', String(x));
  line.setAttribute('y1', String(y));
  line.setAttribute('x2', String(endX));
  line.setAttribute('y2', String(endY));
  line.classList.add('photo-annotation-line');
  line.setAttribute('stroke', annotation.color);
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  marker.setAttribute('cx', String(endX));
  marker.setAttribute('cy', String(endY));
  marker.setAttribute('r', String(Math.max(width, height) * 0.008));
  marker.setAttribute('fill', annotation.color);
  arrow.append(line, marker);
  return arrow;
}
