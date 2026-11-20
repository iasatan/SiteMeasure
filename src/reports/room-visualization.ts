import * as THREE from 'three';
import type { Room } from '../domain/models';
import { roomHeight } from '../geometry';
import { buildPartsGroup } from '../objects/object-preview';
import { escapeHtml } from './project-exports';

export interface RoomVisualizationPhoto {
  label: string;
  dataUrl: string;
}

const VIEW_LABELS = ['Front corner', 'Side corner', 'Rear corner', 'Elevated plan'];

export async function renderRoomPhotos(room: Room): Promise<RoomVisualizationPhoto[]> {
  if (room.walls.length === 0) throw new Error('Add room walls before creating 3D photos.');

  const scene = createRoomScene(room);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(1200, 800, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0xe5e9e3, 1);

  const bounds = new THREE.Box3().setFromObject(scene);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.z, 2) * 0.92;
  const height = roomHeight(room);
  const cameras = [
    cameraAt(center, radius, radius, radius, 48),
    cameraAt(center, -radius, radius, radius, 48),
    cameraAt(center, -radius, radius, -radius, 48),
    cameraAt(center, 0.01, Math.max(radius * 1.65, height * 2.8), 0.01, 65),
  ];

  try {
    return cameras.map((camera, index) => {
      renderer.render(scene, camera);
      return { label: VIEW_LABELS[index], dataUrl: renderer.domElement.toDataURL('image/png') };
    });
  } finally {
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    });
    renderer.dispose();
  }
}

export function roomSlideshowHtml(projectName: string, roomName: string, photos: RoomVisualizationPhoto[]): string {
  const slides = photos.map((photo, index) => `<figure class="slide${index === 0 ? ' active' : ''}"><img src="${photo.dataUrl}" alt="${escapeHtml(roomName)} - ${escapeHtml(photo.label)}"><figcaption><strong>${escapeHtml(photo.label)}</strong><span>${index + 1} / ${photos.length}</span></figcaption></figure>`).join('');
  const title = `${projectName} - ${roomName} 3D walkthrough`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;grid-template-rows:auto 1fr auto;background:#102c26;color:#f4f1e9;font-family:Arial,sans-serif}header{display:flex;align-items:end;justify-content:space-between;gap:16px;padding:22px 4vw}header h1{margin:0;font:500 clamp(1.6rem,5vw,3rem) Georgia,serif}header p{margin:6px 0 0;color:#b8cbc3}.stage{position:relative;display:grid;place-items:center;min-height:0;padding:0 4vw}.slide{display:none;width:min(1200px,100%);margin:0}.slide.active{display:block}.slide img{display:block;width:100%;max-height:72dvh;object-fit:contain;background:#dfe5de}.slide figcaption{display:flex;justify-content:space-between;padding:12px 0;color:#fff;font-size:1rem}.slide figcaption span{color:#b8cbc3}footer{display:flex;justify-content:center;gap:8px;padding:18px 4vw calc(18px + env(safe-area-inset-bottom))}button{min-width:92px;min-height:44px;border:1px solid #6c8178;border-radius:4px;background:#fff;color:#102c26;font:700 .9rem Arial,sans-serif;cursor:pointer}</style></head><body><header><div><h1>${escapeHtml(roomName)}</h1><p>${escapeHtml(projectName)} · 3D room views</p></div><p id="counter">1 / ${photos.length}</p></header><main class="stage">${slides}</main><footer><button id="previous" type="button" aria-label="Previous image">Previous</button><button id="next" type="button" aria-label="Next image">Next</button></footer><script>const slides=[...document.querySelectorAll('.slide')];let current=0;function show(index){slides[current].classList.remove('active');current=(index+slides.length)%slides.length;slides[current].classList.add('active');document.querySelector('#counter').textContent=(current+1)+' / '+slides.length}document.querySelector('#previous').addEventListener('click',()=>show(current-1));document.querySelector('#next').addEventListener('click',()=>show(current+1));addEventListener('keydown',event=>{if(event.key==='ArrowLeft')show(current-1);if(event.key==='ArrowRight')show(current+1)});</script></body></html>`;
}

function createRoomScene(room: Room): THREE.Scene {
  const scene = new THREE.Scene();
  const points = room.points.length >= 3
    ? room.points
    : room.walls.flatMap((wall) => [wall.start, wall.end]);
  const minX = Math.min(...points.map((point) => point.xMeters));
  const maxX = Math.max(...points.map((point) => point.xMeters));
  const minZ = Math.min(...points.map((point) => point.yMeters));
  const maxZ = Math.max(...points.map((point) => point.yMeters));
  const offsetX = (minX + maxX) / 2;
  const offsetZ = (minZ + maxZ) / 2;
  const height = roomHeight(room);
  const wallMaterial = new THREE.MeshStandardMaterial({ color: 0xf7f4ea, roughness: 0.88 });
  const trimMaterial = new THREE.MeshStandardMaterial({ color: 0xd3d9d0, roughness: 0.75 });
  const floorMaterial = new THREE.MeshStandardMaterial({ color: 0xb99067, roughness: 0.78 });

  if (room.points.length >= 3) {
    const shape = new THREE.Shape();
    room.points.forEach((point, index) => {
      const x = point.xMeters - offsetX;
      const y = -(point.yMeters - offsetZ);
      if (index === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    });
    shape.closePath();
    const floor = new THREE.Mesh(new THREE.ShapeGeometry(shape), floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
  } else {
    addBox(scene, maxX - minX, 0.08, maxZ - minZ, 0, 0, 0, floorMaterial);
  }

  for (const wall of room.walls) addWall(scene, room, wall.id, wall.start, wall.end, wall.thicknessMeters, height, offsetX, offsetZ, wallMaterial, trimMaterial);
  for (const object of room.objects) {
    if (object.parts?.length) {
      const group = buildPartsGroup(object.parts, object);
      group.position.set((object.xMeters ?? offsetX) - offsetX, 0, (object.yMeters ?? offsetZ) - offsetZ);
      scene.add(group);
      continue;
    }
    const material = new THREE.MeshStandardMaterial({ color: 0x5c8175, roughness: 0.62 });
    addBox(scene, object.widthMeters, object.heightMeters, object.depthMeters, (object.xMeters ?? offsetX) - offsetX, object.heightMeters / 2, (object.yMeters ?? offsetZ) - offsetZ, material);
  }

  scene.add(new THREE.HemisphereLight(0xf8fbf5, 0x56605b, 2.2));
  const sun = new THREE.DirectionalLight(0xfff3d9, 3.2);
  sun.position.set(maxX - minX, height * 3.5, maxZ - minZ);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun);
  return scene;
}

function addWall(scene: THREE.Scene, room: Room, wallId: string, start: { xMeters: number; yMeters: number }, end: { xMeters: number; yMeters: number }, thickness: number, roomHeightValue: number, offsetX: number, offsetZ: number, wallMaterial: THREE.Material, trimMaterial: THREE.Material): void {
  const dx = end.xMeters - start.xMeters;
  const dz = end.yMeters - start.yMeters;
  const length = Math.hypot(dx, dz);
  if (!length) return;
  const openings = [...room.doors, ...room.windows]
    .filter((opening) => opening.wallId === wallId)
    .map((opening) => ({ ...opening, kind: 'heightMeters' in opening && room.doors.some((door) => door.id === opening.id) ? 'door' : 'window' }))
    .sort((left, right) => left.offsetMeters - right.offsetMeters);
  const angle = Math.atan2(dz, dx);
  const addSegment = (from: number, to: number, bottom: number, top: number, material: THREE.Material) => {
    if (to <= from || top <= bottom) return;
    const distance = (from + to) / 2;
    addBox(
      scene,
      to - from,
      top - bottom,
      Math.max(thickness, 0.06),
      start.xMeters - offsetX + Math.cos(angle) * distance,
      bottom + (top - bottom) / 2,
      start.yMeters - offsetZ + Math.sin(angle) * distance,
      material,
      -angle,
    );
  };

  let cursor = 0;
  for (const opening of openings) {
    const from = THREE.MathUtils.clamp(opening.offsetMeters, 0, length);
    const to = THREE.MathUtils.clamp(opening.offsetMeters + opening.widthMeters, from, length);
    addSegment(cursor, from, 0, roomHeightValue, wallMaterial);
    const openingHeight = Math.min(opening.heightMeters ?? (opening.kind === 'door' ? 2.1 : 1.2), roomHeightValue);
    if (opening.kind === 'window') {
      const sill = Math.max(0, 0.9);
      addSegment(from, to, 0, Math.min(sill, openingHeight), wallMaterial);
      addSegment(from, to, Math.min(sill + openingHeight, roomHeightValue), roomHeightValue, wallMaterial);
    } else {
      addSegment(from, to, openingHeight, roomHeightValue, trimMaterial);
    }
    cursor = to;
  }
  addSegment(cursor, length, 0, roomHeightValue, wallMaterial);
}

function addBox(scene: THREE.Scene, width: number, height: number, depth: number, x: number, y: number, z: number, material: THREE.Material, rotationY = 0): void {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(Math.max(width, 0.01), Math.max(height, 0.01), Math.max(depth, 0.01)), material);
  mesh.position.set(x, y, z);
  mesh.rotation.y = rotationY;
  mesh.castShadow = height > 0.1;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

function cameraAt(center: THREE.Vector3, x: number, y: number, z: number, distanceCompensation: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(42, 3 / 2, 0.05, 200);
  camera.position.set(center.x + x, center.y + y, center.z + z);
  camera.lookAt(center.x, center.y * 0.65, center.z);
  camera.fov = distanceCompensation > 60 ? 48 : 42;
  camera.updateProjectionMatrix();
  return camera;
}
