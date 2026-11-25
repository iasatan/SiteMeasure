import { beforeEach, describe, expect, it } from 'vitest';
import { DebugLog } from '../src/debug-log';

describe('debug recording', () => {
  beforeEach(() => localStorage.clear());

  it('records events and errors, persists across reloads, and stops recording', () => {
    const log = new DebugLog(localStorage, window);
    log.start();
    document.body.dispatchEvent(new Event('click', { bubbles: true }));
    window.dispatchEvent(new ErrorEvent('error', { message: 'Failure', filename: 'app.js', lineno: 3 }));
    expect(log.current?.entries.some((entry) => entry.type === 'event.click')).toBe(true);
    expect(log.current?.entries.some((entry) => entry.type === 'error' && entry.detail.includes('Failure'))).toBe(true);
    expect(JSON.parse(localStorage.getItem('sitemeasure:debug-session') ?? '{}').enabled).toBe(true);
    log.stop();
    const count = log.current?.entries.length;
    document.body.dispatchEvent(new Event('click', { bubbles: true }));
    expect(log.current?.entries.length).toBe(count);
    expect(JSON.parse(localStorage.getItem('sitemeasure:debug-session') ?? '{}').enabled).toBe(false);
  });

  it('resumes saved sessions and limits retained entries', () => {
    localStorage.setItem('sitemeasure:debug-session', JSON.stringify({ enabled: true, startedAt: '2026-01-01', stoppedAt: null, entries: [], dropped: 0 }));
    const log = new DebugLog(localStorage, window);
    expect(log.current?.entries[0].detail).toContain('resumed');
    for (let index = 0; index < 1005; index += 1) log.log('test', index);
    log.stop();
    expect(log.current?.entries).toHaveLength(1000);
    expect(log.current?.dropped).toBeGreaterThan(0);
    expect(JSON.parse(localStorage.getItem('sitemeasure:debug-session') ?? '{}').entries).toHaveLength(1000);
  });

  it('keeps the log in memory when storage is full', () => {
    const storage = new Proxy(localStorage, {
      get(target, property) {
        if (property === 'setItem') return () => { throw new DOMException('Quota reached', 'QuotaExceededError'); };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const log = new DebugLog(storage, window);
    log.start();
    log.log('handled.error', new Error('Failure'));
    log.stop();
    expect(log.hasStorageError).toBe(true);
    expect(log.current?.entries.some((entry) => entry.detail.includes('Failure'))).toBe(true);
  });
});