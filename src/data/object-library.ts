import { createId } from '../domain/models';
import { cloneParts, ObjectValidationError, validateObjectDefinition, type ObjectDefinition } from '../domain/furniture';

export const OBJECT_LIBRARY_KEY = 'sitemeasure:object-library';

export class ObjectLibrary {
  constructor(private readonly storage: Storage) {}

  list(): ObjectDefinition[] {
    const raw = this.storage.getItem(OBJECT_LIBRARY_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const objects: ObjectDefinition[] = [];
      for (const item of parsed) {
        try {
          objects.push(validateObjectDefinition(item));
        } catch {
          // Skip corrupt entries instead of hiding the whole library.
        }
      }
      return objects.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  /** Saves by id; a different object with the same name (case-insensitive) is replaced. */
  save(definition: ObjectDefinition): ObjectDefinition {
    const checked = validateObjectDefinition(definition);
    checked.modifiedAt = new Date().toISOString();
    const others = this.list().filter((item) => item.id !== checked.id && (item.name.toLowerCase() !== checked.name.toLowerCase() || (item.layer ?? 'designer') !== (checked.layer ?? 'designer')));
    this.write([...others, checked]);
    return checked;
  }

  delete(id: string): void {
    this.write(this.list().filter((item) => item.id !== id));
  }

  /** Imports objects, overwriting same-named ones. Returns the imported objects. */
  importAll(definitions: ObjectDefinition[]): ObjectDefinition[] {
    const imported = definitions.map((definition) => {
      const copy = validateObjectDefinition(definition);
      copy.id = createId();
      copy.parts = cloneParts(copy.parts);
      return copy;
    });
    const names = new Set(imported.map((item) => `${item.layer ?? 'designer'}:${item.name.toLowerCase()}`));
    this.write([...this.list().filter((item) => !names.has(`${item.layer ?? 'designer'}:${item.name.toLowerCase()}`)), ...imported]);
    return imported;
  }

  private write(objects: ObjectDefinition[]): void {
    try {
      this.storage.setItem(OBJECT_LIBRARY_KEY, JSON.stringify(objects));
    } catch {
      throw new ObjectValidationError('Device storage is full; the object could not be saved.');
    }
  }
}
