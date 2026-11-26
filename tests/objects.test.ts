import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ObjectLibrary } from '../src/data/object-library';
import { applyPartChange, cloneParts, createObjectDefinition, OBJECT_PRESETS, ObjectValidationError, parseObjectFile, partBounds, scaleParts, serializeObjects, validateParts } from '../src/domain/furniture';
import { buildPartsGroup } from '../src/objects/object-preview';
import { ObjectsPage } from '../src/objects/objects-page';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, value); },
  };
}

describe('object library', () => {
  it('computes bounds and saves by name, replacing same-named objects', () => {
    const library = new ObjectLibrary(memoryStorage());
    const fridge = createObjectDefinition('Fridge', OBJECT_PRESETS[1].build());
    expect(partBounds(fridge.parts).heightMeters).toBeCloseTo(1.8);
    library.save(fridge);
    library.save(createObjectDefinition('fridge', OBJECT_PRESETS[2].build()));
    expect(library.list()).toHaveLength(1);
  });

  it('round-trips through a file and rejects bad files', () => {
    const couch = createObjectDefinition('Couch', OBJECT_PRESETS[0].build());
    const parsed = parseObjectFile(serializeObjects([couch]));
    expect(parsed[0].parts).toHaveLength(couch.parts.length);
    expect(() => parseObjectFile('{"format":"other"}')).toThrow(ObjectValidationError);
    const library = new ObjectLibrary(memoryStorage());
    expect(library.importAll(parsed)[0].id).not.toBe(couch.id);
  });

  it('preserves technical object ownership in the library and object files', () => {
    const socket = OBJECT_PRESETS.find((preset) => preset.label === 'Socket')!;
    const definition = createObjectDefinition(socket.label, socket.build());
    definition.layer = socket.layer;
    const library = new ObjectLibrary(memoryStorage());
    library.save(definition);
    expect(library.list()[0].layer).toBe('technician');
    expect(parseObjectFile(serializeObjects(library.list()))[0].layer).toBe('technician');
    for (const label of ['Electrical wiring', 'Socket', 'Pipe', 'Faucet']) {
      expect(OBJECT_PRESETS.find((preset) => preset.label === label)?.layer).toBe('technician');
    }
  });
});

describe('object library actions', () => {
  it('confirms same-name replacement before saving the object draft', () => {
    const storage = memoryStorage();
    const library = new ObjectLibrary(storage);
    const existing = createObjectDefinition('New object', OBJECT_PRESETS[0].build());
    library.save(existing);
    let confirmAction: (() => void) | undefined;
    const host = {
      layer: () => 'designer' as const,
      projects: () => [],
      rooms: () => [],
      insert: vi.fn(),
      openPlan: vi.fn(),
      download: vi.fn(),
      toast: vi.fn(),
      confirm: vi.fn((_message: string, action: () => void) => { confirmAction = action; }),
    };
    const page = new ObjectsPage(library, host);
    const main = document.createElement('main');
    page.render(main);
    [...main.querySelectorAll('button')].find((item) => item.textContent === 'Save by name')!.click();

    expect(host.confirm).toHaveBeenCalledWith('Replace the saved object "New object"?', expect.any(Function));
    expect(library.list()).toHaveLength(1);
    confirmAction!();
    expect(library.list()).toHaveLength(1);
    expect(library.list()[0].id).not.toBe(existing.id);
  });

  it('reports object deletion storage errors in the page and toast', () => {
    const baseStorage = memoryStorage();
    const existing = createObjectDefinition('Cabinet', OBJECT_PRESETS[0].build());
    new ObjectLibrary(baseStorage).save(existing);
    let failWrites = false;
    const storage = new Proxy(baseStorage, {
      get(target, property) {
        if (property === 'setItem') return (key: string, value: string) => {
          if (failWrites) throw new DOMException('Quota reached', 'QuotaExceededError');
          target.setItem(key, value);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const toast = vi.fn();
    const host = {
      layer: () => 'designer' as const,
      projects: () => [],
      rooms: () => [],
      insert: vi.fn(),
      openPlan: vi.fn(),
      download: vi.fn(),
      toast,
      confirm: vi.fn(),
    };
    const page = new ObjectsPage(new ObjectLibrary(storage), host);
    const main = document.createElement('main');
    page.render(main);
    failWrites = true;
    const row = main.querySelector('.object-row')!;
    [...row.querySelectorAll('button')].find((item) => item.textContent === 'Delete')!.click();

    expect(toast).toHaveBeenCalledWith('Device storage is full; the object could not be saved.');
    expect(main.querySelector('[role="alert"]')?.textContent).toBe('Device storage is full; the object could not be saved.');
    expect(new ObjectLibrary(baseStorage).list()).toHaveLength(1);
  });
});

describe('templates and attachments', () => {
  it('highlights only the selected preview part without changing ordinary object rendering', () => {
    const parts = OBJECT_PRESETS[0].build();
    const preview = buildPartsGroup(parts, undefined, parts[1].id);
    const normal = buildPartsGroup(parts);
    const selected = preview.children[1] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    const unselected = preview.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    const normalPart = normal.children[1] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

    expect(selected.material.emissive.getHex()).toBe(0xffa000);
    expect(selected.children[0]).toBeInstanceOf(THREE.LineSegments);
    expect(unselected.material.emissive.getHex()).toBe(0);
    expect(unselected.children).toHaveLength(0);
    expect(normalPart.material.emissive.getHex()).toBe(0);
    expect(normalPart.children).toHaveLength(0);
  });

  it('ships at least 100 valid templates with unique names', () => {
    expect(OBJECT_PRESETS.length).toBeGreaterThanOrEqual(100);
    expect(new Set(OBJECT_PRESETS.map((preset) => preset.label)).size).toBe(OBJECT_PRESETS.length);
    for (const preset of OBJECT_PRESETS) expect(() => validateParts(preset.build()), preset.label).not.toThrow();
  });

  it('keeps legs attached when the table top is resized or moved', () => {
    const parts = OBJECT_PRESETS.find((preset) => preset.label === 'Table')!.build();
    const top = parts[0];
    applyPartChange(parts, top.id, { widthMeters: 2.4, depthMeters: 1.2 });
    const bounds = partBounds(parts);
    expect(bounds.widthMeters).toBeCloseTo(2.4);
    for (const leg of parts.slice(1)) {
      expect(leg.yMeters + leg.heightMeters / 2).toBeCloseTo(top.yMeters - top.heightMeters / 2);
      expect(Math.abs(leg.xMeters) + leg.widthMeters / 2).toBeLessThanOrEqual(1.2 + 1e-9);
    }
    applyPartChange(parts, top.id, { yMeters: top.yMeters + 0.3 });
    expect(parts[1].yMeters + parts[1].heightMeters / 2).toBeCloseTo(top.yMeters - top.heightMeters / 2);
  });

  it('scales a whole object and preserves attachments through cloning', () => {
    const parts = OBJECT_PRESETS[0].build();
    scaleParts(parts, { widthMeters: 3, heightMeters: 1.2 });
    const bounds = partBounds(parts);
    expect(bounds.widthMeters).toBeCloseTo(3);
    expect(bounds.heightMeters).toBeCloseTo(1.2);
    const copy = cloneParts(parts);
    expect(copy[1].parentId).toBe(copy[0].id);
    expect(copy[0].id).not.toBe(parts[0].id);
  });
});
