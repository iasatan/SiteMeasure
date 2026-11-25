import { describe, expect, it } from 'vitest';
import { ObjectLibrary } from '../src/data/object-library';
import { applyPartChange, cloneParts, createObjectDefinition, OBJECT_PRESETS, ObjectValidationError, parseObjectFile, partBounds, scaleParts, serializeObjects, validateParts } from '../src/domain/furniture';

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

describe('templates and attachments', () => {
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
