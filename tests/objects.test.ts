import { describe, expect, it } from 'vitest';
import { ObjectLibrary } from '../src/data/object-library';
import { createObjectDefinition, OBJECT_PRESETS, ObjectValidationError, parseObjectFile, partBounds, serializeObjects } from '../src/domain/furniture';

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
});
