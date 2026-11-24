import type { Room } from '../domain/models';
import { createRoomPreview } from './room-visualization';

const stage = document.querySelector<HTMLElement>('#room-viewer');
const data = document.querySelector<HTMLScriptElement>('#room-data');
if (stage && data) {
  try {
    createRoomPreview(stage, JSON.parse(data.textContent || '') as Room);
  } catch {
    stage.textContent = 'The 3D room could not be displayed in this browser.';
  }
}