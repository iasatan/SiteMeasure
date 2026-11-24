import * as THREE from 'three';
import type { Room } from '../domain/models';
import { roomHeight } from '../geometry';
import { buildPartsGroup } from '../objects/object-preview';

export function createRoomPreview(container: HTMLElement, room: Room): { dispose(): void } {
  if (room.walls.length === 0) throw new Error('Add room walls before viewing the room in 3D.');

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  const scene = createRoomScene(room);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0xe5e9e3, 1);
  renderer.domElement.className = 'room-visualization-canvas';
  renderer.domElement.setAttribute('aria-label', 'Interactive 3D room view');
  renderer.domElement.tabIndex = 0;
  container.append(renderer.domElement);

  const bounds = new THREE.Box3().setFromObject(scene);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 1);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.01, Math.max(1000, radius * 100));
  let yaw = 0.7;
  let pitch = 1.1;
  let distance = 0;
  let frame = 0;
  let disposed = false;
  const draw = () => {
    frame = 0;
    if (disposed) return;
    const width = container.clientWidth || 320;
    const height = container.clientHeight || 240;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    if (!distance) {
      const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov / 2);
      const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect);
      distance = radius / Math.sin(Math.min(verticalHalfFov, horizontalHalfFov)) * 1.1;
    }
    camera.updateProjectionMatrix();
    camera.position.set(
      center.x + distance * Math.cos(pitch) * Math.sin(yaw),
      center.y + distance * Math.sin(pitch),
      center.z + distance * Math.cos(pitch) * Math.cos(yaw),
    );
    camera.lookAt(center);
    renderer.render(scene, camera);
  };
  const schedule = () => {
    if (!frame && !disposed) frame = requestAnimationFrame(draw);
  };
  const pointers = new Map<number, { x: number; y: number }>();
  renderer.domElement.addEventListener('pointerdown', (event) => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    renderer.domElement.setPointerCapture(event.pointerId);
  });
  renderer.domElement.addEventListener('pointermove', (event) => {
    const pointer = pointers.get(event.pointerId);
    if (!pointer) return;
    const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)?.[1];
    if (other) {
      const previousDistance = Math.hypot(pointer.x - other.x, pointer.y - other.y);
      const nextDistance = Math.hypot(event.clientX - other.x, event.clientY - other.y);
      if (previousDistance && nextDistance) distance = Math.max(radius * 0.25, Math.min(radius * 30, distance * previousDistance / nextDistance));
    } else {
      yaw -= (event.clientX - pointer.x) * 0.01;
      pitch = Math.max(0.05, Math.min(1.5, pitch + (event.clientY - pointer.y) * 0.01));
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    schedule();
  });
  const release = (event: PointerEvent) => { pointers.delete(event.pointerId); };
  renderer.domElement.addEventListener('pointerup', release);
  renderer.domElement.addEventListener('pointercancel', release);
  renderer.domElement.addEventListener('lostpointercapture', release);
  renderer.domElement.addEventListener('wheel', (event) => {
    event.preventDefault();
    distance = Math.max(radius * 0.25, Math.min(radius * 30, distance * (event.deltaY > 0 ? 1.1 : 0.9)));
    schedule();
  }, { passive: false });
  renderer.domElement.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') yaw += 0.1;
    else if (event.key === 'ArrowRight') yaw -= 0.1;
    else if (event.key === 'ArrowUp') pitch = Math.min(1.5, pitch + 0.1);
    else if (event.key === 'ArrowDown') pitch = Math.max(0.05, pitch - 0.1);
    else if (event.key === '+' || event.key === '=') distance = Math.max(radius * 0.25, distance * 0.9);
    else if (event.key === '-') distance = Math.min(radius * 30, distance * 1.1);
    else return;
    event.preventDefault();
    schedule();
  });
  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  resizeObserver?.observe(container);
  schedule();

  return {
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      });
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
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

