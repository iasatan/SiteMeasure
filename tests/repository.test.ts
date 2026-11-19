import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStorageProjectRepository, ProjectPersistenceError, STORAGE_KEYS } from '../src/data/local-storage-repository';
import { createProject } from '../src/domain/models';

describe('LocalStorageProjectRepository', () => {
  beforeEach(() => localStorage.clear());

  it('creates, updates, lists, duplicates, and deletes projects', () => {
    const repository = new LocalStorageProjectRepository(localStorage);
    const project = createProject('North Annex');
    repository.save(project);

    project.customer = 'Hobbi Construction';
    project.modifiedAt = '2026-11-19T12:00:00.000Z';
    repository.save(project);

    expect(repository.list()).toHaveLength(1);
    expect(repository.get(project.id)?.customer).toBe('Hobbi Construction');

    const copy = repository.duplicate(project.id);
    expect(copy.id).not.toBe(project.id);
    expect(copy.name).toBe('North Annex copy');
    expect(repository.list()).toHaveLength(2);

    repository.delete(project.id);
    expect(repository.get(project.id)).toBeNull();
  });

  it('leaves corrupt project data untouched and warns', () => {
    const warning = vi.fn();
    const repository = new LocalStorageProjectRepository(localStorage, warning);
    localStorage.setItem(`${STORAGE_KEYS.projectPrefix}broken`, '{bad json');
    localStorage.setItem(STORAGE_KEYS.projectIndex, JSON.stringify([{ id: 'broken', name: 'Broken', modifiedAt: new Date().toISOString() }]));

    expect(repository.get('broken')).toBeNull();
    expect(repository.list()).toEqual([]);
    expect(warning).toHaveBeenCalled();
    expect(localStorage.getItem(`${STORAGE_KEYS.projectPrefix}broken`)).toBe('{bad json');
  });

  it('creates a migration backup before updating a legacy project', () => {
    const legacy = { ...createProject('Legacy'), schemaVersion: undefined };
    localStorage.setItem(`${STORAGE_KEYS.projectPrefix}${legacy.id}`, JSON.stringify(legacy));

    new LocalStorageProjectRepository(localStorage);

    expect(localStorage.getItem('sitemeasure:migration-backup:0')).toContain('Legacy');
    expect(JSON.parse(localStorage.getItem(`${STORAGE_KEYS.projectPrefix}${legacy.id}`) ?? '{}').schemaVersion).toBe(1);
  });

  it('surfaces storage quota failures', () => {
    localStorage.setItem(STORAGE_KEYS.schemaVersion, '1');
    const storage = new Proxy(localStorage, {
      get(target, property) {
        if (property === 'setItem') return () => {
          throw new DOMException('Quota reached', 'QuotaExceededError');
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const repository = new LocalStorageProjectRepository(storage);
    expect(() => repository.save(createProject('Large project'))).toThrow(ProjectPersistenceError);
  });
});
