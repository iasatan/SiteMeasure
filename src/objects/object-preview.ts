import * as THREE from 'three';
import { partBounds, type ObjectPart } from '../domain/furniture';

/** Builds a group whose bounding-box minimum corner sits at the origin, optionally scaled to a target size. */
export function buildPartsGroup(parts: ObjectPart[], target?: { widthMeters: number; heightMeters: number; depthMeters: number }): THREE.Group {
  const bounds = partBounds(parts);
  const group = new THREE.Group();
  for (const part of parts) {
    const geometry = part.shape === 'cylinder' ? new THREE.CylinderGeometry(0.5, 0.5, 1, 32) : new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: part.color, roughness: 0.65 }));
    mesh.scale.set(part.widthMeters, part.heightMeters, part.depthMeters);
    mesh.position.set(part.xMeters - bounds.min.x, part.yMeters - bounds.min.y, part.zMeters - bounds.min.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (target && bounds.widthMeters > 0 && bounds.heightMeters > 0 && bounds.depthMeters > 0) {
    group.scale.set(target.widthMeters / bounds.widthMeters, target.heightMeters / bounds.heightMeters, target.depthMeters / bounds.depthMeters);
  }
  return group;
}

export interface ObjectPreview {
  setParts(parts: ObjectPart[]): void;
  dispose(): void;
}

/** Interactive preview: drag to orbit, wheel to zoom. Returns null when WebGL is unavailable. */
export function createObjectPreview(container: HTMLElement): ObjectPreview | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.domElement.className = 'object-preview-canvas';
  renderer.domElement.setAttribute('aria-label', '3D object preview');
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf1f3ef);
  scene.add(new THREE.HemisphereLight(0xf8fbf5, 0x56605b, 2.2));
  const sun = new THREE.DirectionalLight(0xfff3d9, 3);
  sun.position.set(3, 5, 4);
  sun.castShadow = true;
  scene.add(sun);
  scene.add(new THREE.GridHelper(6, 12, 0x9aa59f, 0xcfd6d1));
  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);

  let current: THREE.Group | null = null;
  let yaw = 0.7;
  let pitch = 0.45;
  let distance = 4;
  let center = new THREE.Vector3(0, 0.5, 0);
  let frame = 0;
  let disposed = false;

  const draw = () => {
    frame = 0;
    if (disposed) return;
    const width = container.clientWidth || 320;
    const height = container.clientHeight || 240;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
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

  let pointer: { x: number; y: number } | null = null;
  renderer.domElement.addEventListener('pointerdown', (event) => {
    pointer = { x: event.clientX, y: event.clientY };
    renderer.domElement.setPointerCapture(event.pointerId);
  });
  renderer.domElement.addEventListener('pointermove', (event) => {
    if (!pointer) return;
    yaw -= (event.clientX - pointer.x) * 0.01;
    pitch = Math.max(0.05, Math.min(1.5, pitch + (event.clientY - pointer.y) * 0.01));
    pointer = { x: event.clientX, y: event.clientY };
    schedule();
  });
  const release = () => { pointer = null; };
  renderer.domElement.addEventListener('pointerup', release);
  renderer.domElement.addEventListener('pointercancel', release);
  renderer.domElement.addEventListener('wheel', (event) => {
    event.preventDefault();
    distance = Math.max(0.5, Math.min(30, distance * (event.deltaY > 0 ? 1.1 : 0.9)));
    schedule();
  }, { passive: false });
  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  resizeObserver?.observe(container);

  return {
    setParts(parts) {
      if (current) {
        scene.remove(current);
        current.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            node.geometry.dispose();
            (node.material as THREE.Material).dispose();
          }
        });
      }
      const bounds = partBounds(parts);
      current = buildPartsGroup(parts);
      // Centre the model on the grid, resting on the floor.
      current.position.set(-bounds.widthMeters / 2, 0, -bounds.depthMeters / 2);
      scene.add(current);
      center = new THREE.Vector3(0, bounds.heightMeters / 2, 0);
      distance = Math.max(2, Math.max(bounds.widthMeters, bounds.heightMeters, bounds.depthMeters) * 2.4);
      schedule();
    },
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
