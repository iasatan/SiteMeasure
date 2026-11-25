import * as THREE from 'three';
import type { Room } from '../domain/models';
import { pointOnWall, roomHeight, wallElevation } from '../geometry';
import { buildPartsGroup } from '../objects/object-preview';

export function wallViewGeometry(room: Room, wallId: string): { wallIds: string[]; centerX: number; centerZ: number; normalX: number; normalZ: number; width: number } | null {
  const wall = room.walls.find((candidate) => candidate.id === wallId);
  if (!wall) return null;
  const dx = wall.end.xMeters - wall.start.xMeters;
  const dz = wall.end.yMeters - wall.start.yMeters;
  const length = Math.hypot(dx, dz);
  if (length < 0.001) return null;
  const axisX = dx / length;
  const axisZ = dz / length;
  const collinear = room.walls.filter((candidate) => [candidate.start, candidate.end].every((point) => Math.abs((point.xMeters - wall.start.xMeters) * axisZ - (point.yMeters - wall.start.yMeters) * axisX) < 0.001));
  const connected = new Set([wall.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of collinear) {
      if (connected.has(candidate.id)) continue;
      const touches = collinear.some((other) => connected.has(other.id) && [candidate.start, candidate.end].some((point) => [other.start, other.end].some((endpoint) => Math.hypot(point.xMeters - endpoint.xMeters, point.yMeters - endpoint.yMeters) < 0.001)));
      const linked = [...room.doors, ...room.windows].some((opening) => opening.rightWallId && ((opening.wallId === candidate.id && connected.has(opening.rightWallId)) || (opening.rightWallId === candidate.id && connected.has(opening.wallId))));
      if (touches || linked) {
        connected.add(candidate.id);
        changed = true;
      }
    }
  }
  const matching = collinear.filter((candidate) => connected.has(candidate.id));
  const distances = matching.flatMap((candidate) => [candidate.start, candidate.end].map((point) => (point.xMeters - wall.start.xMeters) * axisX + (point.yMeters - wall.start.yMeters) * axisZ));
  const min = Math.min(...distances);
  const max = Math.max(...distances);
  const points = room.points.length >= 3 ? room.points : room.walls.flatMap((candidate) => [candidate.start, candidate.end]);
  const minX = Math.min(...points.map((point) => point.xMeters));
  const maxX = Math.max(...points.map((point) => point.xMeters));
  const minZ = Math.min(...points.map((point) => point.yMeters));
  const maxZ = Math.max(...points.map((point) => point.yMeters));
  const centerX = wall.start.xMeters + axisX * (min + max) / 2;
  const centerZ = wall.start.yMeters + axisZ * (min + max) / 2;
  let normalX = -axisZ;
  let normalZ = axisX;
  const roomX = points.reduce((sum, point) => sum + point.xMeters, 0) / points.length;
  const roomZ = points.reduce((sum, point) => sum + point.yMeters, 0) / points.length;
  if ((roomX - centerX) * normalX + (roomZ - centerZ) * normalZ < 0) {
    normalX = -normalX;
    normalZ = -normalZ;
  }
  return { wallIds: matching.map((candidate) => candidate.id), centerX: centerX - (minX + maxX) / 2, centerZ: centerZ - (minZ + maxZ) / 2, normalX, normalZ, width: max - min };
}

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

  const viewControl = document.createElement('label');
  viewControl.className = 'room-view-control';
  const viewLabel = document.createElement('span');
  viewLabel.textContent = 'View';
  const viewSelect = document.createElement('select');
  viewSelect.setAttribute('aria-label', 'Room view');
  viewSelect.append(new Option('3D', '3d'), new Option('Floor', 'floor'));
  const includedWalls = new Set<string>();
  for (const wall of room.walls) {
    if (includedWalls.has(wall.id)) continue;
    const geometry = wallViewGeometry(room, wall.id);
    if (!geometry) continue;
    geometry.wallIds.forEach((id) => includedWalls.add(id));
    viewSelect.append(new Option(`Wall ${viewSelect.options.length - 1}`, wall.id));
  }
  viewControl.append(viewLabel, viewSelect);
  container.before(viewControl);

  const bounds = new THREE.Box3().setFromObject(scene);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 1);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.01, Math.max(1000, radius * 100));
  const planeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, Math.max(1000, radius * 100));
  let view = '3d';
  let planeZoom = 1;
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
    if (view === '3d') {
      camera.updateProjectionMatrix();
      camera.position.set(
        center.x + distance * Math.cos(pitch) * Math.sin(yaw),
        center.y + distance * Math.sin(pitch),
        center.z + distance * Math.cos(pitch) * Math.cos(yaw),
      );
      camera.lookAt(center);
      renderer.render(scene, camera);
      return;
    }
    const wall = view === 'floor' ? null : wallViewGeometry(room, view);
    const target = wall ? new THREE.Vector3(wall.centerX, roomHeight(room) / 2, wall.centerZ) : center.clone();
    const viewWidth = wall ? wall.width : size.x;
    const viewHeight = wall ? roomHeight(room) : size.z;
    const halfHeight = Math.max(viewHeight, viewWidth / camera.aspect, 0.1) * 0.6 / planeZoom;
    planeCamera.left = -halfHeight * camera.aspect;
    planeCamera.right = halfHeight * camera.aspect;
    planeCamera.top = halfHeight;
    planeCamera.bottom = -halfHeight;
    planeCamera.up.set(0, wall ? 1 : 0, wall ? 0 : -1);
    if (wall) planeCamera.position.set(target.x + wall.normalX * radius * 4, target.y, target.z + wall.normalZ * radius * 4);
    else planeCamera.position.set(target.x, target.y + radius * 4, target.z);
    planeCamera.lookAt(target);
    planeCamera.updateProjectionMatrix();
    renderer.render(scene, planeCamera);
  };
  const schedule = () => {
    if (!frame && !disposed) frame = requestAnimationFrame(draw);
  };
  viewSelect.addEventListener('change', () => {
    view = viewSelect.value;
    planeZoom = 1;
    const visibleWalls = view === '3d' || view === 'floor' ? null : new Set(wallViewGeometry(room, view)?.wallIds);
    for (const child of scene.children) {
      if (typeof child.userData.wallId === 'string') child.visible = !visibleWalls || visibleWalls.has(child.userData.wallId);
    }
    schedule();
  });
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
      if (previousDistance && nextDistance) {
        if (view === '3d') distance = Math.max(radius * 0.25, Math.min(radius * 30, distance * previousDistance / nextDistance));
        else planeZoom = Math.max(0.25, Math.min(10, planeZoom * nextDistance / previousDistance));
      }
    } else if (view === '3d') {
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
    if (view === '3d') distance = Math.max(radius * 0.25, Math.min(radius * 30, distance * (event.deltaY > 0 ? 1.1 : 0.9)));
    else planeZoom = Math.max(0.25, Math.min(10, planeZoom * (event.deltaY > 0 ? 0.9 : 1.1)));
    schedule();
  }, { passive: false });
  renderer.domElement.addEventListener('keydown', (event) => {
    if (view !== '3d') {
      if (event.key === '+' || event.key === '=') planeZoom = Math.min(10, planeZoom * 1.1);
      else if (event.key === '-') planeZoom = Math.max(0.25, planeZoom * 0.9);
      else return;
      event.preventDefault();
      schedule();
      return;
    }
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
      viewControl.remove();
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

  for (const wall of room.walls) {
    const group = new THREE.Group();
    group.userData.wallId = wall.id;
    addWall(group, room, wall.id, wall.start, wall.end, wall.thicknessMeters, height, offsetX, offsetZ, wallMaterial, trimMaterial);
    scene.add(group);
  }
  for (const object of room.objects) {
    const mount = object.wallMount;
    const elevation = mount ? wallElevation(room, mount.wallId) : null;
    const wall = mount ? room.walls.find((candidate) => candidate.id === mount.wallId) : undefined;
    const point = elevation && mount ? pointOnWall(elevation, mount.offsetMeters) : { xMeters: object.xMeters ?? offsetX, yMeters: object.yMeters ?? offsetZ };
    const angle = elevation ? Math.atan2(elevation.axis.yMeters, elevation.axis.xMeters) : 0;
    let normalOffset = 0;
    if (elevation && wall) {
      const normalX = -elevation.axis.yMeters;
      const normalZ = elevation.axis.xMeters;
      const interior = ((offsetX - point.xMeters) * normalX + (offsetZ - point.yMeters) * normalZ) >= 0;
      normalOffset = interior ? wall.thicknessMeters / 2 : -wall.thicknessMeters / 2 - object.depthMeters;
    }
    const x = point.xMeters - offsetX - Math.sin(angle) * normalOffset;
    const z = point.yMeters - offsetZ + Math.cos(angle) * normalOffset;
    const bottom = mount?.elevationMeters ?? 0;
    if (object.parts?.length) {
      const group = buildPartsGroup(object.parts, object);
      group.position.set(x, bottom, z);
      group.rotation.y = -angle;
      scene.add(group);
      continue;
    }
    const material = new THREE.MeshStandardMaterial({ color: 0x5c8175, roughness: 0.62 });
    const centerX = elevation ? x + Math.cos(angle) * object.widthMeters / 2 - Math.sin(angle) * object.depthMeters / 2 : x;
    const centerZ = elevation ? z + Math.sin(angle) * object.widthMeters / 2 + Math.cos(angle) * object.depthMeters / 2 : z;
    addBox(scene, object.widthMeters, object.heightMeters, object.depthMeters, centerX, bottom + object.heightMeters / 2, centerZ, material, -angle);
  }

  scene.add(new THREE.HemisphereLight(0xf8fbf5, 0x56605b, 2.2));
  const sun = new THREE.DirectionalLight(0xfff3d9, 3.2);
  sun.position.set(maxX - minX, height * 3.5, maxZ - minZ);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun);
  return scene;
}

function addWall(scene: THREE.Object3D, room: Room, wallId: string, start: { xMeters: number; yMeters: number }, end: { xMeters: number; yMeters: number }, thickness: number, roomHeightValue: number, offsetX: number, offsetZ: number, wallMaterial: THREE.Material, trimMaterial: THREE.Material): void {
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

function addBox(scene: THREE.Object3D, width: number, height: number, depth: number, x: number, y: number, z: number, material: THREE.Material, rotationY = 0): void {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(Math.max(width, 0.01), Math.max(height, 0.01), Math.max(depth, 0.01)), material);
  mesh.position.set(x, y, z);
  mesh.rotation.y = rotationY;
  mesh.castShadow = height > 0.1;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

