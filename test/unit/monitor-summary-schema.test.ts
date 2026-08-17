import { describe, expect, it } from 'vitest';
import { MonitorSummarySchema } from '../../src/types/monitor-base.js';

describe('MonitorSummarySchema status messages', () => {
  const summary = {
    id: 1,
    name: 'Monitor',
    type: 'http',
    active: true,
    pathName: 'Monitor',
    maintenance: false,
  };

  it('normalizes numeric heartbeat messages to strings', () => {
    const result = MonitorSummarySchema.parse({ ...summary, msg: 42 });

    expect(result.msg).toBe('42');
  });

  it('normalizes heartbeat message arrays to strings', () => {
    const result = MonitorSummarySchema.parse({ ...summary, msg: ['HTTP 500', 'retrying'] });

    expect(result.msg).toBe('HTTP 500, retrying');
  });
});
