import { describe, it, expect, beforeEach } from 'vitest';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { injectMonitorListCache } from './helpers.js';

/**
 * getMonitorList({ parentId }) — issue #65.
 *
 * There was no parent filter at all, so a caller asking for one group's members got every
 * monitor back. The distinction that matters here is `undefined` (no filter) versus `null`
 * (top-level only): conflating them via a truthiness check silently breaks one of the two.
 */
describe('UptimeKumaClient - getMonitorList parentId filter', () => {
  let client: UptimeKumaClient;

  beforeEach(() => {
    client = new UptimeKumaClient('http://localhost:3001');
    injectMonitorListCache(client, {
      '1': { id: 1, name: 'Group A', type: 'group', parent: null, pathName: 'Group A', active: true },
      '2': { id: 2, name: 'Child A1', type: 'http', parent: 1, pathName: 'Group A / Child A1', active: true },
      '3': { id: 3, name: 'Child A2', type: 'http', parent: 1, pathName: 'Group A / Child A2', active: true },
      '4': { id: 4, name: 'Group B', type: 'group', parent: null, pathName: 'Group B', active: true },
      '5': { id: 5, name: 'Child B1', type: 'http', parent: 4, pathName: 'Group B / Child B1', active: true },
      '6': { id: 6, name: 'Grandchild', type: 'http', parent: 5, pathName: 'Group B / Child B1 / Grandchild', active: true },
    });
  });

  it('returns only the direct children of the given group', () => {
    const result = client.getMonitorList({ parentId: 1 });
    expect(Object.keys(result).sort()).toEqual(['2', '3']);
  });

  it('is not recursive — a grandchild is not returned', () => {
    const result = client.getMonitorList({ parentId: 4 });
    expect(Object.keys(result)).toEqual(['5']);
    expect(result['6']).toBeUndefined();
  });

  it('parentId null returns only top-level monitors', () => {
    const result = client.getMonitorList({ parentId: null });
    expect(Object.keys(result).sort()).toEqual(['1', '4']);
  });

  it('omitting parentId returns everything (undefined is not the same as null)', () => {
    expect(Object.keys(client.getMonitorList({})).length).toBe(6);
    expect(Object.keys(client.getMonitorList()).length).toBe(6);
  });

  it('parentId 0 is treated as a real id, not as "no filter"', () => {
    // Guards against a truthiness check: `if (filters.parentId)` would skip filtering here.
    const result = client.getMonitorList({ parentId: 0 });
    expect(Object.keys(result).length).toBe(0);
  });

  it('combines with other filters rather than replacing them', () => {
    const result = client.getMonitorList({ parentId: 1, type: 'http' });
    expect(Object.keys(result).sort()).toEqual(['2', '3']);
    expect(Object.keys(client.getMonitorList({ parentId: 1, type: 'group' })).length).toBe(0);
  });
});
