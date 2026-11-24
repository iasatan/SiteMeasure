import viewerScript from 'virtual:room-viewer-script';
import type { Room } from '../domain/models';
import { escapeHtml } from './project-exports';

export function roomViewerHtml(projectName: string, room: Room): string {
  const model = {
    heightMeters: room.heightMeters,
    points: room.points,
    walls: room.walls,
    doors: room.doors,
    windows: room.windows,
    objects: room.objects,
  };
  const data = JSON.stringify(model).replaceAll('<', '\\u003c');
  const script = viewerScript.replaceAll('</script', '<\\/script');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(room.name)} - 3D room</title><style>*{box-sizing:border-box}body{margin:0;height:100dvh;display:grid;grid-template-rows:auto minmax(0,1fr);background:#f4f1e9;color:#102c26;font-family:Arial,sans-serif}header{padding:16px 20px}h1{margin:0;font:500 1.5rem Georgia,serif}p{margin:5px 0 0;color:#66736f}main{min-height:0}#room-viewer{width:100%;height:100%;background:#e5e9e3}.room-visualization-canvas{display:block;width:100%;height:100%;touch-action:none;cursor:grab}.room-visualization-canvas:active{cursor:grabbing}</style></head><body><header><h1>${escapeHtml(room.name)}</h1><p>${escapeHtml(projectName)}</p></header><main><div id="room-viewer"></div></main><script id="room-data" type="application/json">${data}</script><script>${script}</script></body></html>`;
}