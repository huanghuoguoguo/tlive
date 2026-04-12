/**
 * Tests for Cron REST API handler.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { isCronApiRequest, handleCronApiRequest } from '../../engine/automation/cron-api.js';
import { CronScheduler } from '../../engine/automation/cron.js';
import type { BridgeManager } from '../../engine/coordinators/bridge-manager.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Helpers ──

const createMockBridge = (): BridgeManager => {
  return {
    getAdapter: vi.fn().mockReturnValue({
      channelType: 'telegram',
      send: vi.fn().mockResolvedValue(undefined),
    }),
    getAdapters: vi.fn().mockReturnValue([
      { channelType: 'telegram', send: vi.fn().mockResolvedValue(undefined) },
    ]),
    getLastChatId: vi.fn().mockReturnValue('test-chat-123'),
    injectAutomationPrompt: vi.fn().mockResolvedValue({ sessionId: 'sdk-123' }),
  } as any as BridgeManager;
};

function createMockReq(method: string, url: string, body?: string): IncomingMessage {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;

  if (body !== undefined) {
    // Simulate body data
    process.nextTick(() => {
      req.emit('data', Buffer.from(body));
      req.emit('end');
    });
  } else {
    process.nextTick(() => {
      req.emit('end');
    });
  }

  return req;
}

function createMockRes(): ServerResponse & { _body: string; _status: number } {
  const socket = new Socket();
  const res = new ServerResponse(new IncomingMessage(socket)) as any;
  res._body = '';
  res._status = 200;

  res.writeHead = vi.fn((status: number) => {
    res._status = status;
    return res;
  });
  res.end = vi.fn((data?: string) => {
    if (data) res._body = data;
    return res;
  });

  return res;
}

function parseBody(res: { _body: string }): any {
  return JSON.parse(res._body);
}

// ── Tests ──

describe('isCronApiRequest', () => {
  it('matches /api/cron/jobs', () => {
    expect(isCronApiRequest('/api/cron/jobs')).toBe(true);
  });

  it('matches /api/cron/jobs/:id', () => {
    expect(isCronApiRequest('/api/cron/jobs/cron-abc123')).toBe(true);
  });

  it('matches /api/cron/jobs/:id/enable', () => {
    expect(isCronApiRequest('/api/cron/jobs/cron-abc123/enable')).toBe(true);
  });

  it('does not match /webhook', () => {
    expect(isCronApiRequest('/webhook')).toBe(false);
  });

  it('does not match /api/other', () => {
    expect(isCronApiRequest('/api/other')).toBe(false);
  });

  it('strips query string', () => {
    expect(isCronApiRequest('/api/cron/jobs?foo=bar')).toBe(true);
  });
});

describe('handleCronApiRequest', () => {
  let tempDir: string;
  let scheduler: CronScheduler;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cron-api-test-'));
    scheduler = new CronScheduler({
      runtimeDir: tempDir,
      bridge: createMockBridge(),
      enabled: true,
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns 503 when scheduler is null', async () => {
    const req = createMockReq('GET', '/api/cron/jobs');
    const res = createMockRes();

    await handleCronApiRequest(req, res, null);

    expect(res._status).toBe(503);
    expect(parseBody(res).error).toContain('not enabled');
  });

  it('returns 405 for unsupported method', async () => {
    const req = createMockReq('PATCH', '/api/cron/jobs');
    const res = createMockRes();

    await handleCronApiRequest(req, res, scheduler);

    expect(res._status).toBe(405);
  });

  describe('GET /api/cron/jobs', () => {
    it('returns empty list initially', async () => {
      const req = createMockReq('GET', '/api/cron/jobs');
      const res = createMockRes();

      await handleCronApiRequest(req, res, scheduler);

      expect(res._status).toBe(200);
      expect(parseBody(res).jobs).toEqual([]);
    });

    it('returns jobs after adding one', async () => {
      scheduler.addJob({
        name: 'Test job',
        schedule: '0 9 * * *',
        prompt: 'hello',
        enabled: true,
      });

      const req = createMockReq('GET', '/api/cron/jobs');
      const res = createMockRes();

      await handleCronApiRequest(req, res, scheduler);

      expect(res._status).toBe(200);
      const body = parseBody(res);
      expect(body.jobs).toHaveLength(1);
      expect(body.jobs[0].name).toBe('Test job');
    });
  });

  describe('POST /api/cron/jobs', () => {
    it('creates a new job', async () => {
      const req = createMockReq('POST', '/api/cron/jobs', JSON.stringify({
        name: 'Daily check',
        schedule: '0 9 * * *',
        prompt: 'check status',
        channelType: 'telegram',
        chatId: 'chat-123',
      }));
      const res = createMockRes();

      await handleCronApiRequest(req, res, scheduler);

      expect(res._status).toBe(201);
      const body = parseBody(res);
      expect(body.job.name).toBe('Daily check');
      expect(body.job.schedule).toBe('0 9 * * *');
      expect(body.job.enabled).toBe(true);
      expect(body.job.id).toMatch(/^cron-/);
    });

    it('returns 400 for missing required fields', async () => {
      const req = createMockReq('POST', '/api/cron/jobs', JSON.stringify({
        name: 'No schedule',
      }));
      const res = createMockRes();

      await handleCronApiRequest(req, res, scheduler);

      expect(res._status).toBe(400);
      expect(parseBody(res).error).toContain('Missing required fields');
    });

    it('returns 400 for invalid cron expression', async () => {
      const req = createMockReq('POST', '/api/cron/jobs', JSON.stringify({
        name: 'Bad cron',
        schedule: 'invalid',
        prompt: 'test',
      }));
      const res = createMockRes();

      await handleCronApiRequest(req, res, scheduler);

      expect(res._status).toBe(400);
      expect(parseBody(res).error).toContain('Invalid cron expression');
    });
  });

  describe('GET /api/cron/jobs/:id', () => {
    it('returns a specific job', async () => {
      const job = scheduler.addJob({
        name: 'Specific job',
        schedule: '0 9 * * *',
        prompt: 'test',
        enabled: true,
      });

      const req = createMockReq('GET', `/api/cron/jobs/${job.id}`);
      const res = createMockRes();

      await handleCronApiRequest(req, res, scheduler);

      expect(res._status).toBe(200);
      expect(parseBody(res).job.id).toBe(job.id);
    });

    it('returns 404 for non-existent job', async () => {
      const req = createMockReq('GET', '/api/cron/jobs/non-existent');
      const res = createMockRes();

      await handleCronApiRequest(req, res, scheduler);

      expect(res._status).toBe(404);
    });
  });

  describe('PUT /api/cron/jobs/:id', () => {
    it('updates a job', async () => {
      const job = scheduler.addJob({
        name: 'Original',
        schedule: '0 9 * * *',
        prompt: 'original',
        enabled: true,
      });

      const req = createMockReq('PUT', `/api/cron/jobs/${job.id}`, JSON.stringify({
        name: 'Updated',
        prompt: 'updated prompt',
      }));
      const res = createMockRes();

      await handleCronApiRequest(req, res, scheduler);

      expect(res._status).toBe(200);
      const body = parseBody(res);
      expect(body.job.name).toBe('Updated');
      expect(body.job.prompt).toBe('updated prompt');
    });

    it('returns 404 for non-existent job', async () => {
      const req = createMockReq('PUT', '/api/cron/jobs/non-existent', JSON.stringify({
        name: 'Updated',
      }));
      const res = createMockRes();

      await handleCronApiRequest(req, res, scheduler);

      expect(res._status).toBe(404);
    });
  });

  describe('DELETE /api/cron/jobs/:id', () => {
    it('deletes a job', async () => {
      const job = scheduler.addJob({
        name: 'To delete',
        schedule: '0 9 * * *',
        prompt: 'test',
        enabled: true,
      });

      const req = createMockReq('DELETE', `/api/cron/jobs/${job.id}`);
      const res = createMockRes();

      await handleCronApiRequest(req, res, scheduler);

      expect(res._status).toBe(200);
      expect(parseBody(res).success).toBe(true);
      expect(scheduler.getJob(job.id)).toBeUndefined();
    });

    it('returns 404 for non-existent job', async () => {
      const req = createMockReq('DELETE', '/api/cron/jobs/non-existent');
      const res = createMockRes();

      await handleCronApiRequest(req, res, scheduler);

      expect(res._status).toBe(404);
    });
  });

  describe('POST /api/cron/jobs/:id/enable', () => {
    it('enables a disabled job', async () => {
      const job = scheduler.addJob({
        name: 'Disabled job',
        schedule: '0 9 * * *',
        prompt: 'test',
        enabled: false,
      });

      const req = createMockReq('POST', `/api/cron/jobs/${job.id}/enable`);
      const res = createMockRes();

      await handleCronApiRequest(req, res, scheduler);

      expect(res._status).toBe(200);
      expect(parseBody(res).job.enabled).toBe(true);
    });
  });

  describe('POST /api/cron/jobs/:id/disable', () => {
    it('disables an enabled job', async () => {
      const job = scheduler.addJob({
        name: 'Enabled job',
        schedule: '0 9 * * *',
        prompt: 'test',
        enabled: true,
      });

      const req = createMockReq('POST', `/api/cron/jobs/${job.id}/disable`);
      const res = createMockRes();

      await handleCronApiRequest(req, res, scheduler);

      expect(res._status).toBe(200);
      expect(parseBody(res).job.enabled).toBe(false);
    });
  });
});
