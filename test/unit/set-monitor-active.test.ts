import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';

/**
 * setMonitorActive replaced pauseMonitor and resumeMonitor. Uptime Kuma answers a pause of a
 * missing monitor with ok: true, so the tool checks the monitor exists before either call.
 */
describe('setMonitorActive', () => {
  let pause: ReturnType<typeof vi.spyOn>;
  let resume: ReturnType<typeof vi.spyOn>;

  const call = async (args: Record<string, unknown>) => {
    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
    });
    const client = new Client({ name: 'set-active-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client.callTool({ name: 'setMonitorActive', arguments: args }) as Promise<any>;
  };

  beforeEach(() => {
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({ ok: true, data: {} } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getMonitor').mockImplementation(((id: number) =>
      id === 5 ? { id: 5, name: 'Web' } : undefined) as never);
    pause = vi
      .spyOn(UptimeKumaClient.prototype, 'pauseMonitor')
      .mockResolvedValue({ ok: true, msg: 'successPaused' } as never);
    resume = vi
      .spyOn(UptimeKumaClient.prototype, 'resumeMonitor')
      .mockResolvedValue({ ok: true, msg: 'successResumed' } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pauses with active: false', async () => {
    const result = await call({ monitorID: 5, active: false });

    expect(pause).toHaveBeenCalledWith(5);
    expect(resume).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ ok: true, monitorID: 5, active: false });
  });

  it('resumes with active: true', async () => {
    const result = await call({ monitorID: 5, active: true });

    expect(resume).toHaveBeenCalledWith(5);
    expect(pause).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ ok: true, monitorID: 5, active: true });
  });

  it('requires active rather than guessing a direction', async () => {
    const result = await call({ monitorID: 5 });

    expect(result.isError).toBe(true);
    expect(pause).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('reports a missing monitor as not found instead of a false success', async () => {
    const result = await call({ monitorID: 99, active: false });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Monitor 99 not found');
    expect(pause).not.toHaveBeenCalled();
  });
});
