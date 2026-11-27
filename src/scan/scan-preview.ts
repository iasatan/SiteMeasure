import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildScanGeometry, type ScanMode } from './scan-geometry';
import type { ScanRecord } from './scan-records';

export interface ScanPreview {
  setScan(records: readonly ScanRecord[], mode: ScanMode, fit?: boolean): { count: number; triangles: number };
  dispose(): void;
}

export function createScanPreview(container: HTMLElement): ScanPreview | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.className = 'scan-preview-canvas';
  renderer.domElement.setAttribute('aria-label', 'Interactive 3D scan preview');
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf1f3ef);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x626e68, 2));
  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(3, 5, 4);
  scene.add(light);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.001, 10000);
  const controls = new OrbitControls(camera, renderer.domElement);
  let current: THREE.Group | null = null;
  let frame = 0;
  let disposed = false;
  const draw = () => {
    frame = 0;
    if (disposed) return;
    const width = container.clientWidth || 320;
    const height = container.clientHeight || 300;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  };
  const schedule = () => { if (!frame && !disposed) frame = requestAnimationFrame(draw); };
  controls.addEventListener('change', schedule);
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  observer?.observe(container);

  const clear = () => {
    if (!current) return;
    scene.remove(current);
    current.traverse((node) => {
      if (node instanceof THREE.Mesh || node instanceof THREE.Line || node instanceof THREE.Points) {
        node.geometry.dispose();
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach((material) => material.dispose());
      }
    });
    current = null;
  };

  return {
    setScan(records, mode, fit = false) {
      clear();
      const { geometry, count, triangles } = buildScanGeometry(records, mode);
      current = new THREE.Group();
      const bounds = geometry.boundingBox;
      const size = bounds?.getSize(new THREE.Vector3()).length() || 1;
      const pointMaterial = new THREE.PointsMaterial({ color: 0xc55031, size: Math.max(size * 0.018, 0.015), sizeAttenuation: true });
      current.add(new THREE.Points(geometry, pointMaterial));
      if (mode === 'path' && count > 1) current.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0x176b64 })));
      if ((mode === 'surface' || mode === 'smooth') && triangles) {
        current.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x55998f, side: THREE.DoubleSide, roughness: 0.8, flatShading: mode === 'surface' })));
      }
      scene.add(current);
      if (fit || !count) {
        const center = bounds?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3();
        controls.target.copy(center);
        const distance = Math.max(size * 1.35, 0.5);
        const viewDirection = center.lengthSq() > 0.000001 ? center.clone().normalize().negate() : new THREE.Vector3(0.6, 0.45, 1).normalize();
        camera.position.copy(center).addScaledVector(viewDirection, distance);
        controls.update();
      }
      schedule();
      return { count, triangles };
    },
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      controls.dispose();
      clear();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}