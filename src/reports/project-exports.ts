import type { Project, Room } from '../domain/models';
import { distanceBetween, openingArea, polygonIssues, roomArea, roomHeight, roomVolume, wallArea } from '../geometry';

export function measurementsCsv(project: Project): string {
  const rows: string[][] = [['Project', 'Building', 'Floor', 'Room', 'Target type', 'Target ID', 'Value (m)', 'Captured at', 'Source', 'Device', 'Simulated']];
  for (const building of project.buildings) {
    for (const floor of building.floors) {
      for (const room of floor.rooms) {
        for (const measurement of room.measurements) {
          rows.push([
            project.name, building.name, floor.name, room.name, measurement.targetType, measurement.targetId,
            measurement.valueMeters.toFixed(3), measurement.capturedAt, measurement.source,
            measurement.deviceName ?? '', measurement.simulated ? 'yes' : 'no',
          ]);
        }
      }
    }
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export function floorPlanSvg(project: Project, room: Room): string {
  const points = [...room.points, ...room.walls.flatMap((wall) => [wall.start, wall.end])];
  const minX = points.length ? Math.min(...points.map((point) => point.xMeters)) - 1 : -1;
  const minY = points.length ? Math.min(...points.map((point) => point.yMeters)) - 1 : -1;
  const width = points.length ? Math.max(2, Math.max(...points.map((point) => point.xMeters)) - minX + 1) : 14;
  const height = points.length ? Math.max(2, Math.max(...points.map((point) => point.yMeters)) - minY + 1) : 11;
  const polygonPoints = room.points.map((point) => `${point.xMeters},${point.yMeters}`).join(' ');
  const polygon = room.points.length >= 3 ? `<polygon points="${polygonPoints}" class="room"/>` : '';
  const walls = room.walls.map((wall) => `<g><line x1="${wall.start.xMeters}" y1="${wall.start.yMeters}" x2="${wall.end.xMeters}" y2="${wall.end.yMeters}" class="wall"/><text x="${(wall.start.xMeters + wall.end.xMeters) / 2}" y="${(wall.start.yMeters + wall.end.yMeters) / 2 - 0.18}">${escapeXml(distanceBetween(wall.start, wall.end).toFixed(2))} m</text></g>`).join('');
  const openings = [...room.doors.map((opening) => ({ opening, type: 'door' })), ...room.windows.map((opening) => ({ opening, type: 'window' }))].map(({ opening, type }) => {
    const wall = room.walls.find((candidate) => candidate.id === opening.wallId);
    if (!wall) return '';
    const angle = Math.atan2(wall.end.yMeters - wall.start.yMeters, wall.end.xMeters - wall.start.xMeters);
    const startX = wall.start.xMeters + Math.cos(angle) * opening.offsetMeters;
    const startY = wall.start.yMeters + Math.sin(angle) * opening.offsetMeters;
    return `<line x1="${startX}" y1="${startY}" x2="${startX + Math.cos(angle) * opening.widthMeters}" y2="${startY + Math.sin(angle) * opening.widthMeters}" class="${type}"/>`;
  }).join('');
  const outputHeight = Math.round(1600 * height / width);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="${outputHeight}" viewBox="${minX} ${minY} ${width} ${height}" role="img" aria-label="${escapeXml(project.name)} ${escapeXml(room.name)}"><style>.room{fill:#fff;stroke:#173b33;stroke-width:.04}.wall{stroke:#173b33;stroke-width:.1;stroke-linecap:square}.door{stroke:#e85d3f;stroke-width:.12}.window{stroke:#2782a5;stroke-width:.09}text{font:700 .26px sans-serif;fill:#173b33;text-anchor:middle}</style><rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="#e1e5dd"/>${polygon}${walls}${openings}</svg>`;
}

export async function svgToPng(svg: string, width = 1600): Promise<Blob> {
  const source = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(source);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener('error', () => reject(new Error('The floor plan image could not be rendered.')), { once: true });
      image.src = url;
    });
    const scale = width / Math.max(1, image.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('PNG export is unavailable in this browser.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The floor plan PNG could not be created.')), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function printableReport(project: Project): string {
  const roomSections = project.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.rooms.map((room) => reportRoom(project, building.name, floor.name, room)))).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(project.name)} report</title><style>@page{margin:18mm}body{font-family:Arial,sans-serif;color:#102c26;line-height:1.4}h1{font:32px Georgia;margin:0}h2{margin-top:28px;border-bottom:2px solid #173b33}.meta,.facts{display:grid;grid-template-columns:repeat(2,1fr);gap:8px 18px}.measurement,.note{border-top:1px solid #c9d0c9;padding:7px 0}.photo-frame{position:relative;page-break-inside:avoid}.photo{display:block;max-width:100%;max-height:130mm}.photo-overlay{position:absolute;top:0;left:0;width:100%;height:calc(100% - 2.5rem);pointer-events:none}.photo-overlay *{vector-effect:non-scaling-stroke;stroke-width:3}.photo-overlay text{font:700 28px sans-serif;stroke:white;paint-order:stroke}.warning{color:#80520c}section{page-break-inside:avoid}@media print{button{display:none}}</style></head><body><h1>${escapeHtml(project.name)}</h1><div class="meta"><p><strong>Project:</strong> ${escapeHtml(project.projectNumber || 'Not set')}</p><p><strong>Customer:</strong> ${escapeHtml(project.customer || 'Not set')}</p><p><strong>Address:</strong> ${escapeHtml(project.address || 'Not set')}</p><p><strong>Exported:</strong> ${escapeHtml(new Date().toLocaleString())}</p></div>${roomSections}</body></html>`;
}

function reportRoom(project: Project, building: string, floor: string, room: Room): string {
  const issues = polygonIssues(room.points).filter(() => room.points.length > 0);
  const measurements = room.measurements.map((measurement) => `<div class="measurement"><strong>${measurement.valueMeters.toFixed(3)} m</strong> · ${escapeHtml(measurement.source)} · ${escapeHtml(new Date(measurement.capturedAt).toLocaleString())}${measurement.simulated ? ' · SIMULATED' : ''}</div>`).join('');
  const notes = room.notes.map((note) => `<p class="note">${escapeHtml(note)}</p>`).join('');
  const photos = room.photos.map((photo) => {
    const annotations = photo.annotations.map((annotation) => {
      const x = annotation.x * 1000;
      const y = annotation.y * 1000;
      const endX = (annotation.endX ?? annotation.x) * 1000;
      const endY = (annotation.endY ?? annotation.y) * 1000;
      if (annotation.type === 'text') return `<text x="${x}" y="${y}" fill="${annotation.color}">${escapeXml(annotation.text ?? '')}</text>`;
      if (annotation.type === 'circle') return `<ellipse cx="${(x + endX) / 2}" cy="${(y + endY) / 2}" rx="${Math.abs(endX - x) / 2}" ry="${Math.abs(endY - y) / 2}" fill="none" stroke="${annotation.color}"/>`;
      if (annotation.type === 'rectangle') return `<rect x="${Math.min(x, endX)}" y="${Math.min(y, endY)}" width="${Math.abs(endX - x)}" height="${Math.abs(endY - y)}" fill="none" stroke="${annotation.color}"/>`;
      return `<line x1="${x}" y1="${y}" x2="${endX}" y2="${endY}" stroke="${annotation.color}"/><circle cx="${endX}" cy="${endY}" r="8" fill="${annotation.color}"/>`;
    }).join('');
    const photoNotes = photo.notes ? ` — ${escapeHtml(photo.notes)}` : '';
    return `<figure class="photo-frame"><img class="photo" src="${photo.dataUrl}" alt="${escapeHtml(photo.title)}"><svg class="photo-overlay" viewBox="0 0 1000 1000" preserveAspectRatio="none">${annotations}</svg><figcaption><strong>${escapeHtml(photo.title)}</strong>${photoNotes}</figcaption></figure>`;
  }).join('');
  const location = escapeHtml(building + ' / ' + floor + ' / ' + room.name);
  const warning = issues.length ? `<p class="warning">${escapeHtml(issues.join(' '))}</p>` : '';
  return `<section><h2>${location}</h2><div class="facts"><p><strong>Area:</strong> ${roomArea(room).toFixed(2)} m²</p><p><strong>Volume:</strong> ${roomVolume(room).toFixed(2)} m³</p><p><strong>Net wall area:</strong> ${wallArea(room.walls, roomHeight(room), openingArea(room.walls, room)).toFixed(2)} m²</p><p><strong>Measurements:</strong> ${room.measurements.length}</p></div>${warning}<div>${measurements || '<p>No measurements recorded.</p>'}</div><div>${notes}</div><div>${photos}</div><p>Preferred units: ${escapeHtml(project.preferredUnits)}</p></section>`;
}

export function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function escapeXml(value: string): string {
  return escapeHtml(value);
}
