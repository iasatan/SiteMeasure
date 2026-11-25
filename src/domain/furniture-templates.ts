import { createId } from './models';
import type { ObjectPart } from './furniture';

export interface ObjectPreset {
  label: string;
  category: string;
  layer?: 'technician' | 'designer';
  build: () => ObjectPart[];
}

interface Spec {
  shape: 'box' | 'cylinder';
  x: number; y: number; z: number; w: number; h: number; d: number;
  color: string;
  /** Index of the part this one sticks to. Defaults to the first part; -1 means unattached. */
  parent?: number;
}

const WOOD = '#a0764f';
const DARK = '#6b4a2f';
const LIGHT = '#d8b98a';
const WHITE = '#e8e8e4';
const METAL = '#9aa3a8';
const DGREY = '#3a3f44';
const BLACK = '#222629';
const BLUE = '#6b7f8c';
const RED = '#9c4a43';
const GREEN = '#5c8c5c';
const BEIGE = '#cbb99b';
const GLASS = '#bcd8e6';
const CREAM = '#f1ede3';

const B = (x: number, y: number, z: number, w: number, h: number, d: number, color: string, parent?: number): Spec => ({ shape: 'box', x, y, z, w, h, d, color, parent });
const C = (x: number, y: number, z: number, w: number, h: number, d: number, color: string, parent?: number): Spec => ({ shape: 'cylinder', x, y, z, w, h, d, color, parent });

function make(specs: Spec[]): ObjectPart[] {
  const ids = specs.map(() => createId());
  return specs.map((spec, index) => {
    const parentIndex = spec.parent ?? 0;
    const part: ObjectPart = { id: ids[index], shape: spec.shape, xMeters: spec.x, yMeters: spec.y, zMeters: spec.z, widthMeters: spec.w, heightMeters: spec.h, depthMeters: spec.d, color: spec.color };
    if (index > 0 && parentIndex >= 0 && parentIndex !== index) part.parentId = ids[parentIndex];
    return part;
  });
}

function legs(w: number, d: number, h: number, t: number, color: string, inset = 0.04): Spec[] {
  const x = w / 2 - inset - t / 2;
  const z = d / 2 - inset - t / 2;
  return [[-x, -z], [x, -z], [-x, z], [x, z]].map(([lx, lz]) => B(lx, h / 2, lz, t, h, t, color));
}

function table(w: number, d: number, h: number, color = WOOD, legColor = DARK, top = 0.04, t = 0.06): Spec[] {
  return [B(0, h - top / 2, 0, w, top, d, color), ...legs(w, d, h - top, t, legColor)];
}

function roundTable(dia: number, h: number, color = WOOD): Spec[] {
  return [C(0, h - 0.02, 0, dia, 0.04, dia, color), C(0, (h - 0.04) / 2, 0, 0.08, h - 0.04, 0.08, DARK), C(0, 0.015, 0, dia * 0.45, 0.03, dia * 0.45, DARK)];
}

function cabinet(w: number, d: number, h: number, color: string, doors = 2, handle = METAL): Spec[] {
  const specs = [B(0, h / 2, 0, w, h, d, color)];
  for (let i = 0; i < doors; i++) specs.push(B(-w / 2 + (w / doors) * (i + 0.5) + (doors > 1 ? (i === 0 ? 0.04 : -0.04) : 0), h * 0.55, d / 2 + 0.015, 0.03, 0.2, 0.03, handle));
  return specs;
}

function shelf(w: number, d: number, h: number, boards: number, color = WOOD): Spec[] {
  const specs = [B(0, 0.02, 0, w, 0.04, d, color), B(-w / 2 + 0.01, h / 2, 0, 0.02, h, d, color), B(w / 2 - 0.01, h / 2, 0, 0.02, h, d, color), B(0, h / 2, -d / 2 + 0.005, w, h, 0.01, color)];
  for (let i = 1; i <= boards; i++) specs.push(B(0, (h / (boards + 1)) * i, 0, w - 0.04, 0.025, d - 0.02, color));
  return specs;
}

function sofa(w: number, color: string, dark: string): Spec[] {
  return [B(0, 0.2, 0, w, 0.4, 0.9, color), B(0, 0.6, -0.35, w, 0.5, 0.2, dark), B(-w / 2 + 0.1, 0.5, 0.05, 0.2, 0.2, 0.8, dark), B(w / 2 - 0.1, 0.5, 0.05, 0.2, 0.2, 0.8, dark)];
}

function chair(color = WOOD, seatColor = BEIGE): Spec[] {
  return [B(0, 0.45, 0, 0.45, 0.05, 0.45, seatColor), B(0, 0.7, -0.2, 0.45, 0.45, 0.04, color), ...legs(0.45, 0.45, 0.425, 0.04, color, 0)];
}

function bed(w: number, l: number, frame = LIGHT, linen = CREAM): Spec[] {
  return [B(0, 0.25, 0, w, 0.3, l, frame), B(0, 0.5, 0.05, w - 0.05, 0.2, l - 0.15, linen), B(0, 0.75, -l / 2 + 0.03, w, 0.7, 0.06, frame), B(-w * 0.22, 0.65, -l / 2 + 0.3, w * 0.38, 0.12, 0.35, WHITE)];
}

function bin(dia: number, h: number, color: string): Spec[] {
  return [C(0, h / 2, 0, dia, h, dia, color), C(0, h + 0.02, 0, dia + 0.02, 0.04, dia + 0.02, DGREY)];
}

function plant(pot: number, h: number): Spec[] {
  return [C(0, 0.15, 0, pot, 0.3, pot, RED), C(0, 0.3 + (h - 0.3) / 2, 0, pot * 0.3, h - 0.3, pot * 0.3, DARK), C(0, h - 0.2, 0, pot * 1.6, 0.4, pot * 1.6, GREEN)];
}

function lamp(h: number, shade: number): Spec[] {
  return [C(0, 0.02, 0, 0.3, 0.04, 0.3, DGREY), C(0, h / 2, 0, 0.04, h, 0.04, METAL), C(0, h - 0.15, 0, shade, 0.3, shade, CREAM)];
}

function appliance(w: number, d: number, h: number, color = WHITE, door = true): Spec[] {
  const specs = [B(0, h / 2, 0, w, h, d, color)];
  if (door) specs.push(B(0, h / 2, d / 2 + 0.005, w * 0.8, h * 0.6, 0.01, GLASS), B(w / 2 - 0.08, h * 0.92, d / 2 + 0.01, 0.1, 0.03, 0.01, METAL));
  return specs;
}

function screen(w: number, h: number): Spec[] {
  return [B(0, h / 2 + 0.1, 0, w, h, 0.03, BLACK), B(0, 0.05, 0, w * 0.3, 0.02, 0.2, DGREY), B(0, 0.1, -0.02, 0.05, 0.1, 0.05, DGREY)];
}

export const OBJECT_PRESETS: ObjectPreset[] = [
  { label: 'Couch', category: 'Seating', build: () => make(sofa(2, '#6b7f8c', '#58707e')) },
  { label: 'Fridge', category: 'Kitchen', build: () => make([B(0, 0.9, 0, 0.7, 1.8, 0.7, '#e3e7e8'), B(0.28, 1.2, 0.36, 0.04, 0.5, 0.04, '#8a9296'), B(0.28, 0.5, 0.36, 0.04, 0.4, 0.04, '#8a9296')]) },
  { label: 'Table', category: 'Tables', build: () => make(table(1.4, 0.8, 0.76)) },
  { label: 'Bed', category: 'Bedroom', build: () => make(bed(1.6, 2)) },
  { label: 'Round stool', category: 'Seating', build: () => make([C(0, 0.225, 0, 0.4, 0.45, 0.4, WOOD)]) },
  { label: 'Electrical wiring', category: 'Electrical', layer: 'technician', build: () => make([B(0, 0.02, 0, 1, 0.04, 0.04, RED)]) },
  { label: 'Socket', category: 'Electrical', layer: 'technician', build: () => make([B(0, 0.3, 0, 0.09, 0.09, 0.03, WHITE), C(0, 0.3, 0.02, 0.025, 0.01, 0.025, DGREY)]) },
  { label: 'Pipe', category: 'Plumbing', layer: 'technician', build: () => make([B(0, 0.03, 0, 1, 0.06, 0.06, METAL)]) },
  { label: 'Faucet', category: 'Plumbing', layer: 'technician', build: () => make([C(0, 0.1, 0, 0.05, 0.2, 0.05, METAL), B(0, 0.19, 0.07, 0.05, 0.04, 0.16, METAL)]) },

  { label: 'Loveseat', category: 'Seating', build: () => make(sofa(1.4, BLUE, '#58707e')) },
  { label: 'Three-seat sofa', category: 'Seating', build: () => make(sofa(2.3, RED, '#7d3a34')) },
  { label: 'Armchair', category: 'Seating', build: () => make([B(0, 0.2, 0, 0.9, 0.4, 0.85, GREEN), B(0, 0.6, -0.33, 0.9, 0.5, 0.2, '#4a7a4a'), B(-0.4, 0.5, 0.05, 0.14, 0.2, 0.75, '#4a7a4a'), B(0.4, 0.5, 0.05, 0.14, 0.2, 0.75, '#4a7a4a')]) },
  { label: 'Corner sofa', category: 'Seating', build: () => make([B(0, 0.2, 0, 2.6, 0.4, 0.9, BLUE), B(0, 0.6, -0.35, 2.6, 0.5, 0.2, '#58707e'), B(-0.85, 0.2, 0.9, 0.9, 0.4, 0.9, BLUE), B(-1.25, 0.5, 0.9, 0.2, 0.2, 0.9, '#58707e')]) },
  { label: 'Ottoman', category: 'Seating', build: () => make([B(0, 0.2, 0, 0.6, 0.4, 0.6, '#8c6b8c')]) },
  { label: 'Pouf', category: 'Seating', build: () => make([C(0, 0.18, 0, 0.5, 0.36, 0.5, '#c9a24b')]) },
  { label: 'Dining chair', category: 'Seating', build: () => make(chair()) },
  { label: 'Bar stool', category: 'Seating', build: () => make([C(0, 0.72, 0, 0.36, 0.05, 0.36, BLACK), C(0, 0.35, 0, 0.04, 0.7, 0.04, METAL), C(0, 0.01, 0, 0.35, 0.02, 0.35, METAL)]) },
  { label: 'Bench', category: 'Seating', build: () => make([B(0, 0.45, 0, 1.2, 0.05, 0.35, WOOD), ...legs(1.2, 0.35, 0.425, 0.05, DARK, 0.03)]) },
  { label: 'Park bench', category: 'Outdoor', build: () => make([B(0, 0.45, 0, 1.6, 0.05, 0.45, WOOD), B(0, 0.75, -0.2, 1.6, 0.4, 0.04, WOOD), ...legs(1.6, 0.45, 0.425, 0.06, DGREY, 0.05)]) },
  { label: 'Office chair', category: 'Office', build: () => make([B(0, 0.5, 0, 0.5, 0.08, 0.5, DGREY), B(0, 0.85, -0.23, 0.48, 0.5, 0.06, DGREY), C(0, 0.25, 0, 0.06, 0.42, 0.06, METAL), C(0, 0.02, 0, 0.6, 0.04, 0.6, BLACK)]) },
  { label: 'Recliner', category: 'Seating', build: () => make([B(0, 0.25, 0, 0.9, 0.5, 1.0, '#5a4636'), B(0, 0.75, -0.42, 0.9, 0.7, 0.16, '#4a382b'), B(-0.5, 0.55, 0.05, 0.12, 0.3, 0.9, '#4a382b'), B(0.5, 0.55, 0.05, 0.12, 0.3, 0.9, '#4a382b')]) },
  { label: 'Bean bag', category: 'Seating', build: () => make([C(0, 0.3, 0, 0.9, 0.6, 0.9, '#d9803f')]) },
  { label: 'Folding chair', category: 'Seating', build: () => make([B(0, 0.45, 0, 0.4, 0.03, 0.4, METAL), B(0, 0.7, -0.19, 0.4, 0.4, 0.03, METAL), ...legs(0.4, 0.4, 0.43, 0.025, DGREY, 0)]) },
  { label: 'High chair', category: 'Seating', build: () => make([B(0, 0.55, 0, 0.4, 0.04, 0.4, WHITE), B(0, 0.85, -0.18, 0.4, 0.45, 0.04, WHITE), B(0, 0.62, 0.15, 0.4, 0.03, 0.15, '#e9c46a'), ...legs(0.5, 0.5, 0.53, 0.04, WOOD, 0)]) },
  { label: 'Sun lounger', category: 'Outdoor', build: () => make([B(0, 0.3, 0, 0.65, 0.08, 1.9, WHITE), B(0, 0.55, -0.7, 0.65, 0.08, 0.7, WHITE), ...legs(0.6, 1.9, 0.26, 0.04, METAL, 0.05)]) },
  { label: 'Garden chair', category: 'Outdoor', build: () => make([B(0, 0.42, 0, 0.55, 0.05, 0.55, GREEN), B(0, 0.7, -0.25, 0.55, 0.5, 0.05, GREEN), ...legs(0.55, 0.55, 0.4, 0.04, DGREY, 0)]) },
  { label: 'Piano stool', category: 'Seating', build: () => make([C(0, 0.5, 0, 0.35, 0.08, 0.35, BLACK), C(0, 0.23, 0, 0.05, 0.46, 0.05, METAL), C(0, 0.01, 0, 0.3, 0.02, 0.3, METAL)]) },

  { label: 'Dining table', category: 'Tables', build: () => make(table(1.8, 0.9, 0.75)) },
  { label: 'Round dining table', category: 'Tables', build: () => make(roundTable(1.1, 0.75)) },
  { label: 'Coffee table', category: 'Tables', build: () => make(table(1.0, 0.55, 0.42, LIGHT)) },
  { label: 'Round coffee table', category: 'Tables', build: () => make(roundTable(0.8, 0.4, LIGHT)) },
  { label: 'Side table', category: 'Tables', build: () => make(table(0.45, 0.45, 0.55, LIGHT, DARK, 0.03, 0.04)) },
  { label: 'Desk', category: 'Office', build: () => make([...table(1.4, 0.7, 0.75), B(0.5, 0.58, 0, 0.4, 0.4, 0.6, WOOD, 0)]) },
  { label: 'Corner desk', category: 'Office', build: () => make([B(0, 0.73, 0, 1.6, 0.04, 0.7, WOOD), B(-0.45, 0.73, 0.85, 0.7, 0.04, 1.0, WOOD), ...legs(1.6, 0.7, 0.71, 0.05, DGREY).slice(0, 4), B(-0.75, 0.36, 1.3, 0.05, 0.71, 0.05, DGREY)]) },
  { label: 'Standing desk', category: 'Office', build: () => make([B(0, 1.05, 0, 1.4, 0.04, 0.7, LIGHT), B(-0.6, 0.52, 0, 0.06, 1.03, 0.6, DGREY), B(0.6, 0.52, 0, 0.06, 1.03, 0.6, DGREY)]) },
  { label: 'Console table', category: 'Tables', build: () => make(table(1.2, 0.35, 0.8, DARK, DARK, 0.03, 0.04)) },
  { label: 'Bar table', category: 'Tables', build: () => make([C(0, 1.08, 0, 0.7, 0.04, 0.7, DARK), C(0, 0.53, 0, 0.06, 1.06, 0.06, METAL), C(0, 0.01, 0, 0.5, 0.02, 0.5, METAL)]) },
  { label: 'Picnic table', category: 'Outdoor', build: () => make([B(0, 0.74, 0, 1.8, 0.05, 0.75, WOOD), B(0, 0.43, -0.7, 1.8, 0.05, 0.28, WOOD), B(0, 0.43, 0.7, 1.8, 0.05, 0.28, WOOD), B(-0.7, 0.37, 0, 0.06, 0.74, 1.5, DARK), B(0.7, 0.37, 0, 0.06, 0.74, 1.5, DARK)]) },
  { label: 'Workbench', category: 'Workshop', build: () => make([B(0, 0.9, 0, 1.8, 0.06, 0.7, WOOD), ...legs(1.8, 0.7, 0.87, 0.08, DARK, 0.02), B(0, 0.3, 0, 1.6, 0.03, 0.55, DARK, 0)]) },
  { label: 'Conference table', category: 'Office', build: () => make(table(3.2, 1.2, 0.74, DARK, DGREY, 0.05, 0.1)) },
  { label: 'Reception desk', category: 'Office', build: () => make([B(0, 0.55, 0, 2.0, 1.1, 0.7, LIGHT), B(0, 1.13, 0.1, 2.0, 0.04, 0.5, DARK)]) },
  { label: 'Kids table', category: 'Tables', build: () => make(table(0.8, 0.6, 0.5, '#e9c46a', BLUE, 0.03, 0.05)) },
  { label: 'Drafting table', category: 'Workshop', build: () => make([B(0, 0.95, 0, 1.0, 0.04, 0.7, LIGHT), ...legs(0.9, 0.6, 0.93, 0.05, DGREY, 0.03)]) },
  { label: 'Folding table', category: 'Tables', build: () => make(table(1.8, 0.75, 0.74, WHITE, METAL, 0.04, 0.04)) },
  { label: 'Nesting table', category: 'Tables', build: () => make(table(0.5, 0.4, 0.5, BLACK, METAL, 0.025, 0.03)) },

  { label: 'Single bed', category: 'Bedroom', build: () => make(bed(0.95, 2)) },
  { label: 'Double bed', category: 'Bedroom', build: () => make(bed(1.4, 2)) },
  { label: 'King bed', category: 'Bedroom', build: () => make(bed(1.9, 2.1, DARK)) },
  { label: 'Bunk bed', category: 'Bedroom', build: () => make([B(0, 0.3, 0, 0.95, 0.2, 2, LIGHT), B(0, 1.3, 0, 0.95, 0.2, 2, LIGHT), B(-0.46, 0.9, -0.95, 0.06, 1.8, 0.06, DARK), B(0.46, 0.9, -0.95, 0.06, 1.8, 0.06, DARK), B(-0.46, 0.9, 0.95, 0.06, 1.8, 0.06, DARK), B(0.46, 0.9, 0.95, 0.06, 1.8, 0.06, DARK), B(0, 0.45, 0, 0.85, 0.1, 1.9, CREAM, 0), B(0, 1.45, 0, 0.85, 0.1, 1.9, CREAM, 1)]) },
  { label: 'Crib', category: 'Bedroom', build: () => make([B(0, 0.4, 0, 0.7, 0.1, 1.3, LIGHT), B(0, 0.7, 0.63, 0.7, 0.55, 0.04, LIGHT), B(0, 0.7, -0.63, 0.7, 0.55, 0.04, LIGHT), B(-0.33, 0.7, 0, 0.04, 0.55, 1.3, LIGHT), B(0.33, 0.7, 0, 0.04, 0.55, 1.3, LIGHT), ...legs(0.7, 1.3, 0.35, 0.05, DARK, 0)]) },
  { label: 'Daybed', category: 'Bedroom', build: () => make([B(0, 0.3, 0, 0.95, 0.25, 2, METAL), B(0, 0.5, 0, 0.9, 0.15, 1.95, CREAM), B(0, 0.7, -0.95, 0.95, 0.4, 0.05, METAL)]) },
  { label: 'Mattress', category: 'Bedroom', build: () => make([B(0, 0.1, 0, 1.4, 0.2, 2, CREAM)]) },
  { label: 'Futon', category: 'Bedroom', build: () => make([B(0, 0.15, 0, 1.4, 0.3, 1.9, '#5a6b8c')]) },
  { label: 'Nightstand', category: 'Bedroom', build: () => make([B(0, 0.25, 0, 0.45, 0.5, 0.4, LIGHT), B(0, 0.38, 0.21, 0.12, 0.03, 0.02, METAL), B(0, 0.15, 0.21, 0.12, 0.03, 0.02, METAL)]) },
  { label: 'Vanity table', category: 'Bedroom', build: () => make([...table(1.0, 0.45, 0.75, WHITE, WHITE, 0.04, 0.05), B(0, 1.2, -0.2, 0.7, 0.8, 0.02, GLASS, 0)]) },

  { label: 'Wardrobe', category: 'Storage', build: () => make(cabinet(1.2, 0.6, 2.1, WOOD, 2)) },
  { label: 'Sliding wardrobe', category: 'Storage', build: () => make([B(0, 1.05, 0, 2.0, 2.1, 0.6, WHITE), B(-0.5, 1.05, 0.31, 1.0, 2.0, 0.02, GLASS), B(0.5, 1.05, 0.33, 1.0, 2.0, 0.02, LIGHT)]) },
  { label: 'Dresser', category: 'Storage', build: () => make([B(0, 0.45, 0, 1.0, 0.9, 0.5, LIGHT), B(0, 0.75, 0.26, 0.3, 0.03, 0.02, METAL), B(0, 0.5, 0.26, 0.3, 0.03, 0.02, METAL), B(0, 0.25, 0.26, 0.3, 0.03, 0.02, METAL)]) },
  { label: 'Chest of drawers', category: 'Storage', build: () => make([B(0, 0.6, 0, 0.8, 1.2, 0.45, WOOD), B(0, 1.0, 0.24, 0.3, 0.03, 0.02, METAL), B(0, 0.7, 0.24, 0.3, 0.03, 0.02, METAL), B(0, 0.4, 0.24, 0.3, 0.03, 0.02, METAL), B(0, 0.15, 0.24, 0.3, 0.03, 0.02, METAL)]) },
  { label: 'Bookshelf', category: 'Storage', build: () => make(shelf(0.9, 0.3, 1.2, 3)) },
  { label: 'Tall bookcase', category: 'Storage', build: () => make(shelf(0.9, 0.32, 2.0, 5, DARK)) },
  { label: 'Cube shelf', category: 'Storage', build: () => make(shelf(1.4, 0.38, 1.4, 3, WHITE)) },
  { label: 'Low cabinet', category: 'Storage', build: () => make(cabinet(0.9, 0.4, 0.8, WHITE, 2)) },
  { label: 'Sideboard', category: 'Storage', build: () => make(cabinet(1.6, 0.45, 0.85, DARK, 3)) },
  { label: 'TV stand', category: 'Living room', build: () => make([...cabinet(1.5, 0.4, 0.5, DARK, 2), B(0.3, 0.2, 0, 0.5, 0.35, 0.36, METAL, 0)]) },
  { label: 'Shoe rack', category: 'Storage', build: () => make(shelf(0.8, 0.3, 0.6, 2, WOOD)) },
  { label: 'Filing cabinet', category: 'Office', build: () => make([B(0, 0.65, 0, 0.45, 1.3, 0.6, METAL), B(0, 1.05, 0.31, 0.15, 0.03, 0.02, DGREY), B(0, 0.65, 0.31, 0.15, 0.03, 0.02, DGREY), B(0, 0.25, 0.31, 0.15, 0.03, 0.02, DGREY)]) },
  { label: 'Locker', category: 'Storage', build: () => make([B(0, 0.9, 0, 0.4, 1.8, 0.5, '#4a6fa5'), B(0.12, 1.0, 0.26, 0.03, 0.15, 0.02, METAL)]) },
  { label: 'Blanket chest', category: 'Storage', build: () => make([B(0, 0.25, 0, 1.0, 0.5, 0.5, DARK), B(0, 0.52, 0, 1.02, 0.05, 0.52, WOOD)]) },
  { label: 'Toy box', category: 'Storage', build: () => make([B(0, 0.25, 0, 0.8, 0.5, 0.45, '#e9c46a'), B(0, 0.52, 0, 0.82, 0.04, 0.47, RED)]) },
  { label: 'Coat rack', category: 'Storage', build: () => make([C(0, 0.9, 0, 0.05, 1.8, 0.05, DARK), C(0, 0.01, 0, 0.4, 0.02, 0.4, DARK), B(0, 1.7, 0, 0.4, 0.03, 0.03, DARK), B(0, 1.7, 0, 0.03, 0.03, 0.4, DARK)]) },
  { label: 'Wall shelf', category: 'Storage', build: () => make([B(0, 1.5, 0, 0.9, 0.03, 0.22, WOOD)]) },
  { label: 'Display cabinet', category: 'Storage', build: () => make([B(0, 0.9, 0, 0.9, 1.8, 0.4, DARK), B(0, 1.1, 0.205, 0.8, 1.4, 0.01, GLASS)]) },
  { label: 'Pantry cabinet', category: 'Kitchen', build: () => make(cabinet(0.6, 0.6, 2.1, WHITE, 1)) },
  { label: 'Wine rack', category: 'Storage', build: () => make(shelf(0.6, 0.3, 0.9, 3, DARK)) },
  { label: 'Wall cabinet', category: 'Kitchen', build: () => make([B(0, 1.8, 0, 0.8, 0.7, 0.35, WHITE), B(0.3, 1.6, 0.18, 0.03, 0.2, 0.02, METAL)]) },
  { label: 'Umbrella stand', category: 'Storage', build: () => make([C(0, 0.25, 0, 0.25, 0.5, 0.25, METAL)]) },
  { label: 'Magazine rack', category: 'Living room', build: () => make([B(0, 0.2, 0, 0.4, 0.4, 0.2, WOOD)]) },

  { label: 'Freezer', category: 'Kitchen', build: () => make([B(0, 0.425, 0, 0.6, 0.85, 0.6, WHITE), B(0.22, 0.6, 0.31, 0.03, 0.2, 0.02, METAL)]) },
  { label: 'Double-door fridge', category: 'Kitchen', build: () => make([B(0, 0.9, 0, 0.9, 1.8, 0.75, METAL), B(-0.04, 1.2, 0.38, 0.03, 0.5, 0.03, DGREY), B(0.04, 1.2, 0.38, 0.03, 0.5, 0.03, DGREY)]) },
  { label: 'Cooker', category: 'Kitchen', build: () => make([...appliance(0.6, 0.6, 0.9, WHITE), C(-0.15, 0.91, -0.15, 0.15, 0.02, 0.15, BLACK), C(0.15, 0.91, -0.15, 0.15, 0.02, 0.15, BLACK), C(-0.15, 0.91, 0.15, 0.15, 0.02, 0.15, BLACK), C(0.15, 0.91, 0.15, 0.15, 0.02, 0.15, BLACK)]) },
  { label: 'Wall oven', category: 'Kitchen', build: () => make(appliance(0.6, 0.55, 0.6, METAL)) },
  { label: 'Dishwasher', category: 'Kitchen', build: () => make(appliance(0.6, 0.6, 0.85, METAL, false)) },
  { label: 'Washing machine', category: 'Kitchen', build: () => make([B(0, 0.425, 0, 0.6, 0.85, 0.6, WHITE), C(0, 0.45, 0.31, 0.38, 0.02, 0.38, GLASS)].map((s, i) => (i === 1 ? { ...s, shape: 'cylinder' as const } : s))) },
  { label: 'Tumble dryer', category: 'Kitchen', build: () => make(appliance(0.6, 0.6, 0.85, WHITE)) },
  { label: 'Kitchen counter', category: 'Kitchen', build: () => make([B(0, 0.43, 0, 0.6, 0.86, 0.6, WHITE), B(0, 0.88, 0, 0.62, 0.04, 0.62, DGREY)]) },
  { label: 'Kitchen island', category: 'Kitchen', build: () => make([B(0, 0.45, 0, 1.6, 0.9, 0.8, WHITE), B(0, 0.93, 0, 1.7, 0.05, 0.9, DGREY)]) },
  { label: 'Sink unit', category: 'Kitchen', build: () => make([B(0, 0.43, 0, 1.2, 0.86, 0.6, WHITE), B(0, 0.88, 0, 1.22, 0.04, 0.62, DGREY), B(-0.2, 0.9, 0, 0.5, 0.03, 0.4, METAL)]) },
  { label: 'Microwave', category: 'Kitchen', build: () => make([B(0, 0.14, 0, 0.5, 0.28, 0.38, DGREY), B(-0.06, 0.14, 0.195, 0.3, 0.2, 0.01, GLASS)]) },
  { label: 'Range hood', category: 'Kitchen', build: () => make([B(0, 1.85, 0, 0.6, 0.15, 0.5, METAL), B(0, 2.2, -0.1, 0.25, 0.55, 0.2, METAL)]) },
  { label: 'Coffee machine', category: 'Kitchen', build: () => make([B(0, 0.18, 0, 0.3, 0.36, 0.35, DGREY), B(0, 0.1, 0.12, 0.1, 0.1, 0.1, GLASS)]) },
  { label: 'Bin', category: 'Kitchen', build: () => make(bin(0.35, 0.6, METAL)) },
  { label: 'Dish rack', category: 'Kitchen', build: () => make([B(0, 0.08, 0, 0.5, 0.16, 0.35, METAL)]) },

  { label: 'Bathtub', category: 'Bathroom', build: () => make([B(0, 0.28, 0, 1.7, 0.56, 0.75, WHITE), B(0, 0.5, 0, 1.5, 0.05, 0.55, GLASS)]) },
  { label: 'Shower tray', category: 'Bathroom', build: () => make([B(0, 0.04, 0, 0.9, 0.08, 0.9, WHITE)]) },
  { label: 'Shower cabin', category: 'Bathroom', build: () => make([B(0, 0.04, 0, 0.9, 0.08, 0.9, WHITE), B(0, 1.1, 0.43, 0.9, 2.0, 0.02, GLASS), B(0.43, 1.1, 0, 0.02, 2.0, 0.9, GLASS)]) },
  { label: 'Toilet', category: 'Bathroom', build: () => make([B(0, 0.2, 0, 0.38, 0.4, 0.55, WHITE), B(0, 0.7, -0.22, 0.38, 0.4, 0.18, WHITE)]) },
  { label: 'Bidet', category: 'Bathroom', build: () => make([B(0, 0.2, 0, 0.36, 0.4, 0.55, WHITE)]) },
  { label: 'Wash basin', category: 'Bathroom', build: () => make([B(0, 0.85, 0, 0.55, 0.15, 0.45, WHITE), C(0, 0.4, 0, 0.12, 0.7, 0.12, WHITE)]) },
  { label: 'Bathroom vanity', category: 'Bathroom', build: () => make([B(0, 0.4, 0, 0.8, 0.8, 0.5, LIGHT), B(0, 0.83, 0, 0.8, 0.06, 0.5, WHITE), B(0, 1.5, -0.24, 0.6, 0.8, 0.03, GLASS, 0)]) },
  { label: 'Towel radiator', category: 'Bathroom', build: () => make([B(0, 0.9, 0, 0.5, 1.2, 0.08, WHITE)]) },
  { label: 'Laundry basket', category: 'Bathroom', build: () => make([C(0, 0.3, 0, 0.4, 0.6, 0.4, BEIGE)]) },
  { label: 'Water heater', category: 'Utility', build: () => make([C(0, 0.8, 0, 0.5, 1.6, 0.5, WHITE)]) },
  { label: 'Boiler', category: 'Utility', build: () => make([B(0, 0.4, 0, 0.45, 0.8, 0.35, WHITE), B(0.1, 0.55, 0.18, 0.2, 0.15, 0.01, DGREY)]) },

  { label: 'TV on wall', category: 'Electronics', build: () => make([B(0, 1.4, 0, 1.2, 0.7, 0.05, BLACK)]) },
  { label: 'TV on stand', category: 'Electronics', build: () => make(screen(1.2, 0.7)) },
  { label: 'Desktop monitor', category: 'Electronics', build: () => make(screen(0.55, 0.32)) },
  { label: 'Computer tower', category: 'Electronics', build: () => make([B(0, 0.22, 0, 0.2, 0.44, 0.45, DGREY)]) },
  { label: 'Laptop', category: 'Electronics', build: () => make([B(0, 0.01, 0, 0.35, 0.02, 0.25, METAL), B(0, 0.12, -0.12, 0.35, 0.22, 0.01, BLACK)]) },
  { label: 'Speaker', category: 'Electronics', build: () => make([B(0, 0.3, 0, 0.2, 0.6, 0.2, BLACK), C(0, 0.4, 0.105, 0.14, 0.02, 0.14, DGREY)]) },
  { label: 'Printer', category: 'Electronics', build: () => make([B(0, 0.15, 0, 0.45, 0.3, 0.4, WHITE)]) },
  { label: 'Server rack', category: 'Electronics', build: () => make([B(0, 1.0, 0, 0.6, 2.0, 0.9, BLACK)]) },
  { label: 'Air conditioner', category: 'Utility', build: () => make([B(0, 2.2, 0, 0.9, 0.3, 0.2, WHITE)]) },
  { label: 'Radiator', category: 'Utility', build: () => make([B(0, 0.5, 0, 1.0, 0.6, 0.1, WHITE)]) },
  { label: 'Standing fan', category: 'Electronics', build: () => make([C(0, 0.02, 0, 0.35, 0.04, 0.35, DGREY), C(0, 0.5, 0, 0.04, 1.0, 0.04, METAL), C(0, 1.05, 0, 0.4, 0.05, 0.4, GLASS)]) },
  { label: 'Floor lamp', category: 'Lighting', build: () => make(lamp(1.6, 0.4)) },
  { label: 'Table lamp', category: 'Lighting', build: () => make(lamp(0.45, 0.25)) },
  { label: 'Pendant lamp', category: 'Lighting', build: () => make([C(0, 2.0, 0, 0.45, 0.3, 0.45, CREAM), C(0, 2.4, 0, 0.02, 0.5, 0.02, BLACK)]) },

  { label: 'Plant pot', category: 'Decor', build: () => make(plant(0.3, 0.9)) },
  { label: 'Tall plant', category: 'Decor', build: () => make(plant(0.4, 1.7)) },
  { label: 'Planter box', category: 'Outdoor', build: () => make([B(0, 0.2, 0, 1.0, 0.4, 0.3, DARK)]) },
  { label: 'Rug', category: 'Decor', build: () => make([B(0, 0.01, 0, 2.0, 0.02, 1.4, RED)]) },
  { label: 'Round rug', category: 'Decor', build: () => make([C(0, 0.01, 0, 1.6, 0.02, 1.6, BLUE)]) },
  { label: 'Floor mirror', category: 'Decor', build: () => make([B(0, 0.85, 0, 0.5, 1.7, 0.04, GLASS)]) },
  { label: 'Whiteboard', category: 'Office', build: () => make([B(0, 1.5, 0, 1.5, 1.0, 0.03, WHITE)]) },
  { label: 'Fireplace', category: 'Living room', build: () => make([B(0, 0.6, 0, 1.2, 1.2, 0.4, '#8a8078'), B(0, 0.35, 0.21, 0.6, 0.5, 0.02, BLACK)]) },
  { label: 'Wood stove', category: 'Living room', build: () => make([B(0, 0.45, 0, 0.5, 0.9, 0.45, BLACK), C(0, 1.4, 0, 0.15, 1.0, 0.15, DGREY)]) },
  { label: 'Piano', category: 'Living room', build: () => make([B(0, 0.6, 0, 1.5, 1.2, 0.6, BLACK), B(0, 0.7, 0.4, 1.4, 0.05, 0.25, WHITE)]) },
  { label: 'Aquarium', category: 'Decor', build: () => make([B(0, 0.4, 0, 1.0, 0.8, 0.4, GLASS)]) },

  { label: 'Cardboard box', category: 'Misc', build: () => make([B(0, 0.2, 0, 0.5, 0.4, 0.4, '#b9935a')]) },
  { label: 'Pallet', category: 'Misc', build: () => make([B(0, 0.07, 0, 1.2, 0.14, 0.8, WOOD)]) },
  { label: 'Barrel', category: 'Misc', build: () => make([C(0, 0.45, 0, 0.6, 0.9, 0.6, DARK)]) },
  { label: 'Ladder', category: 'Workshop', build: () => make([B(-0.2, 1.0, 0, 0.04, 2.0, 0.06, METAL), B(0.2, 1.0, 0, 0.04, 2.0, 0.06, METAL), B(0, 0.3, 0, 0.4, 0.03, 0.05, METAL, 0), B(0, 0.8, 0, 0.4, 0.03, 0.05, METAL, 0), B(0, 1.3, 0, 0.4, 0.03, 0.05, METAL, 0), B(0, 1.8, 0, 0.4, 0.03, 0.05, METAL, 0)]) },
  { label: 'Stairs', category: 'Misc', build: () => make([B(0, 0.1, 0, 1.0, 0.2, 0.3, WOOD), B(0, 0.3, 0.3, 1.0, 0.2, 0.3, WOOD), B(0, 0.5, 0.6, 1.0, 0.2, 0.3, WOOD), B(0, 0.7, 0.9, 1.0, 0.2, 0.3, WOOD)]) },
  { label: 'Treadmill', category: 'Fitness', build: () => make([B(0, 0.15, 0, 0.8, 0.3, 1.8, DGREY), B(0, 1.0, -0.8, 0.8, 0.3, 0.1, BLACK)]) },
  { label: 'Exercise bike', category: 'Fitness', build: () => make([B(0, 0.1, 0, 0.5, 0.2, 1.0, DGREY), B(0, 0.7, 0.2, 0.06, 0.8, 0.06, METAL), B(0, 1.05, -0.3, 0.3, 0.05, 0.2, BLACK)]) },
  { label: 'Punching bag', category: 'Fitness', build: () => make([C(0, 1.0, 0, 0.35, 1.2, 0.35, RED)]) },
  { label: 'Barbecue', category: 'Outdoor', build: () => make([C(0, 0.85, 0, 0.6, 0.3, 0.6, BLACK), ...legs(0.6, 0.6, 0.7, 0.04, METAL, 0.02)]) },
  { label: 'Parasol', category: 'Outdoor', build: () => make([C(0, 1.1, 0, 0.05, 2.2, 0.05, DARK), C(0, 2.2, 0, 2.2, 0.15, 2.2, '#e9c46a'), C(0, 0.02, 0, 0.4, 0.04, 0.4, DGREY)]) },
  { label: 'Mailbox', category: 'Outdoor', build: () => make([B(0, 1.2, 0, 0.3, 0.4, 0.15, RED)]) },
  { label: 'Dog bed', category: 'Misc', build: () => make([C(0, 0.1, 0, 0.8, 0.2, 0.8, '#8c6b50')]) },
  { label: 'Cat tree', category: 'Misc', build: () => make([B(0, 0.04, 0, 0.5, 0.08, 0.5, BEIGE), C(0, 0.5, 0, 0.1, 1.0, 0.1, BEIGE), B(0, 1.0, 0, 0.4, 0.06, 0.4, BEIGE)]) },
  { label: 'Dressing screen', category: 'Decor', build: () => make([B(-0.4, 0.85, 0, 0.5, 1.7, 0.03, LIGHT), B(0.1, 0.85, 0.1, 0.5, 1.7, 0.03, LIGHT), B(0.6, 0.85, 0, 0.5, 1.7, 0.03, LIGHT)]) },
  { label: 'Ironing board', category: 'Misc', build: () => make([B(0, 0.9, 0, 0.35, 0.03, 1.2, BLUE), B(0, 0.45, 0, 0.04, 0.9, 0.5, METAL)]) },
  { label: 'Bicycle', category: 'Misc', build: () => make([B(0, 0.5, 0, 0.05, 0.05, 1.0, BLUE), C(0, 0.33, 0.55, 0.04, 0.66, 0.66, BLACK), C(0, 0.33, -0.55, 0.04, 0.66, 0.66, BLACK)].map((s, i) => (i > 0 ? { ...s, shape: 'cylinder' as const } : s))) },
];
