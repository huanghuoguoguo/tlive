/**
 * Tests for CronScheduler — Phase 3 automation entry.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseCronExpression,
  calculateNextRun,
  CronScheduler,
  type CronJob,
} from '../../engine/automation/cron.js';
import type { BridgeManager } from '../../engine/coordinators/bridge-manager.js';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock BridgeManager
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
    handleInboundMessage: vi.fn().mockResolvedValue(true),
  } as any as BridgeManager;
};

describe('parseCronExpression', () => {
  it('parses standard 5-field cron expressions', () => {
    // Every minute
    const everyMin = parseCronExpression('* * * * *');
    expect(everyMin).toEqual({
      minute: '*',
      hour: '*',
      day: '*',
      month: '*',
      weekday: '*',
    });

    // 9am on Mondays (weekday 1)
    // Note: Simplified parser doesn't support ranges like 1-5
    const nineAmMonday = parseCronExpression('0 9 * * 1');
    expect(nineAmMonday).toEqual({
      minute: 0,
      hour: 9,
      day: '*',
      month: '*',
      weekday: 1,
    });
  });

  it('parses specific times', () => {
    // 3:30 PM on the 15th of every month
    const specific = parseCronExpression('30 15 15 * *');
    expect(specific).toEqual({
      minute: 30,
      hour: 15,
      day: 15,
      month: '*',
      weekday: '*',
    });
  });

  it('returns null for invalid expressions', () => {
    // Wrong number of fields
    expect(parseCronExpression('* * *')).toBeNull();
    expect(parseCronExpression('* * * * * *')).toBeNull();

    // Invalid values
    expect(parseCronExpression('60 9 * * *')).toBeNull(); // minute > 59
    expect(parseCronExpression('0 24 * * *')).toBeNull(); // hour > 23
    expect(parseCronExpression('0 0 32 * *')).toBeNull(); // day > 31
    expect(parseCronExpression('0 0 1 13 *')).toBeNull(); // month > 12
    expect(parseCronExpression('0 0 * * 7')).toBeNull(); // weekday > 6
  });

  it('handles wildcards correctly', () => {
    const wildcard = parseCronExpression('* * * * *');
    expect(wildcard?.minute).toBe('*');
    expect(wildcard?.hour).toBe('*');
    expect(wildcard?.day).toBe('*');
    expect(wildcard?.month).toBe('*');
    expect(wildcard?.weekday).toBe('*');
  });
});

describe('calculateNextRun', () => {
  it('calculates next run for every-minute expression', () => {
    const now = new Date('2024-01-15T10:30:45Z').getTime();
    const next = calculateNextRun('* * * * *', now);
    expect(next).toBeDefined();
    // Should be the next minute boundary
    const nextDate = new Date(next!);
    expect(nextDate.getMinutes()).toBe(31);
    expect(nextDate.getSeconds()).toBe(0);
  });

  it('calculates next run for specific hour', () => {
    const now = new Date('2024-01-15T08:30:00Z').getTime();
    const next = calculateNextRun('0 9 * * *', now); // 9am every day
    expect(next).toBeDefined();
    const nextDate = new Date(next!);
    expect(nextDate.getHours()).toBe(9);
    expect(nextDate.getMinutes()).toBe(0);
  });

  it('calculates next run when current time is past scheduled time', () => {
    const now = new Date('2024-01-15T10:30:00Z').getTime();
    const next = calculateNextRun('0 9 * * *', now); // 9am, but we're at 10:30
    expect(next).toBeDefined();
    const nextDate = new Date(next!);
    // Should be tomorrow at 9am
    expect(nextDate.getDate()).toBe(16);
    expect(nextDate.getHours()).toBe(9);
    expect(nextDate.getMinutes()).toBe(0);
  });

  it('handles weekday constraints', () => {
    // Monday = 1, Friday = 5
    // Test on Saturday (6) looking for weekday job
    const saturday = new Date('2024-01-20T10:00:00Z').getTime(); // Saturday
    const next = calculateNextRun('0 9 * * 1', saturday); // Monday 9am
    expect(next).toBeDefined();
    const nextDate = new Date(next!);
    expect(nextDate.getDay()).toBe(1); // Monday
  });

  it('returns null for invalid expressions', () => {
    expect(calculateNextRun('invalid')).toBeNull();
    expect(calculateNextRun('* * *')).toBeNull();
  });
});

describe('CronScheduler', () => {
  let tempDir: string;
  let mockBridge: BridgeManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cron-test-'));
    mockBridge = createMockBridge();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('creates scheduler with disabled state', () => {
    const scheduler = new CronScheduler({
      runtimeDir: tempDir,
      bridge: mockBridge,
      enabled: false,
    });

    expect(scheduler.listJobs()).toHaveLength(0);
    // Should not load or save jobs when disabled
    const jobsPath = join(tempDir, 'cron-jobs.json');
    expect(existsSync(jobsPath)).toBe(false);
  });

  it('adds a new job with valid schedule', () => {
    const scheduler = new CronScheduler({
      runtimeDir: tempDir,
      bridge: mockBridge,
      enabled: true,
    });

    const job = scheduler.addJob({
      name: 'Daily review',
      schedule: '0 9 * * *',
      channelType: 'telegram',
      chatId: 'test-chat',
      prompt: 'Review the daily progress',
      event: 'daily-review',
      enabled: true,
    });

    expect(job.id).toMatch(/^cron-/);
    expect(job.name).toBe('Daily review');
    expect(job.schedule).toBe('0 9 * * *');
    expect(job.enabled).toBe(true);
    expect(job.createdAt).toBeDefined();
    expect(job.nextRun).toBeDefined();
  });

  it('rejects invalid cron expression when adding job', () => {
    const scheduler = new CronScheduler({
      runtimeDir: tempDir,
      bridge: mockBridge,
      enabled: true,
    });

    expect(() => {
      scheduler.addJob({
        name: 'Invalid job',
        schedule: 'invalid cron',
        prompt: 'test',
        enabled: true,
      });
    }).toThrow('Invalid cron expression');
  });

  it('persists jobs to JSON file', () => {
    const scheduler = new CronScheduler({
      runtimeDir: tempDir,
      bridge: mockBridge,
      enabled: true,
    });

    scheduler.addJob({
      name: 'Test job',
      schedule: '0 9 * * *',
      prompt: 'test',
      enabled: true,
    });

    const jobsPath = join(tempDir, 'cron-jobs.json');
    expect(existsSync(jobsPath)).toBe(true);

    const savedData = JSON.parse(readFileSync(jobsPath, 'utf-8'));
    expect(savedData.version).toBe(1);
    expect(savedData.jobs).toHaveLength(1);
    expect(savedData.jobs[0].name).toBe('Test job');
  });

  it('loads persisted jobs on startup', () => {
    // Pre-populate jobs file
    const jobsPath = join(tempDir, 'cron-jobs.json');
    const existingJobs: CronJob[] = [{
      id: 'cron-existing',
      name: 'Existing job',
      schedule: '30 12 * * *',
      prompt: 'existing prompt',
      enabled: true,
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 1000,
    }];
    writeFileSync(jobsPath, JSON.stringify({ jobs: existingJobs, version: 1 }));

    const scheduler = new CronScheduler({
      runtimeDir: tempDir,
      bridge: mockBridge,
      enabled: true,
    });

    const jobs = scheduler.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('Existing job');
  });

  it('updates existing job', () => {
    const scheduler = new CronScheduler({
      runtimeDir: tempDir,
      bridge: mockBridge,
      enabled: true,
    });

    const job = scheduler.addJob({
      name: 'Original name',
      schedule: '0 9 * * *',
      prompt: 'original prompt',
      enabled: true,
    });

    const updated = scheduler.updateJob(job.id, {
      name: 'Updated name',
      prompt: 'updated prompt',
    });

    expect(updated?.name).toBe('Updated name');
    expect(updated?.prompt).toBe('updated prompt');
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(job.createdAt);
  });

  it('recalculates nextRun when schedule changes', () => {
    const scheduler = new CronScheduler({
      runtimeDir: tempDir,
      bridge: mockBridge,
      enabled: true,
    });

    const job = scheduler.addJob({
      name: 'Test',
      schedule: '0 9 * * *',
      prompt: 'test',
      enabled: true,
    });
    const originalNextRun = job.nextRun;

    const updated = scheduler.updateJob(job.id, {
      schedule: '0 15 * * *', // Change to 3pm
    });

    expect(updated?.nextRun).not.toBe(originalNextRun);
  });

  it('removes job', () => {
    const scheduler = new CronScheduler({
      runtimeDir: tempDir,
      bridge: mockBridge,
      enabled: true,
    });

    const job = scheduler.addJob({
      name: 'To be removed',
      schedule: '0 9 * * *',
      prompt: 'test',
      enabled: true,
    });

    expect(scheduler.listJobs()).toHaveLength(1);
    const removed = scheduler.removeJob(job.id);
    expect(removed).toBe(true);
    expect(scheduler.listJobs()).toHaveLength(0);
  });

  it('enables and disables jobs', () => {
    const scheduler = new CronScheduler({
      runtimeDir: tempDir,
      bridge: mockBridge,
      enabled: true,
    });

    const job = scheduler.addJob({
      name: 'Toggle test',
      schedule: '0 9 * * *',
      prompt: 'test',
      enabled: true,
    });

    const disabled = scheduler.setJobEnabled(job.id, false);
    expect(disabled?.enabled).toBe(false);

    const enabled = scheduler.setJobEnabled(job.id, true);
    expect(enabled?.enabled).toBe(true);
    // nextRun should be recalculated when re-enabled
    expect(enabled?.nextRun).toBeDefined();
  });

  it('returns null for non-existent job operations', () => {
    const scheduler = new CronScheduler({
      runtimeDir: tempDir,
      bridge: mockBridge,
      enabled: true,
    });

    expect(scheduler.getJob('non-existent')).toBeUndefined();
    expect(scheduler.updateJob('non-existent', { name: 'test' })).toBeNull();
    expect(scheduler.removeJob('non-existent')).toBe(false);
    expect(scheduler.setJobEnabled('non-existent', true)).toBeNull();
  });

  it('start and stop lifecycle', () => {
    const scheduler = new CronScheduler({
      runtimeDir: tempDir,
      bridge: mockBridge,
      enabled: true,
    });

    // Should not throw
    scheduler.start();
    scheduler.stop();
    scheduler.stop(); // Double stop should be safe

    // Disabled scheduler should not start
    const disabledScheduler = new CronScheduler({
      runtimeDir: tempDir,
      bridge: mockBridge,
      enabled: false,
    });
    disabledScheduler.start(); // Should do nothing
    disabledScheduler.stop();
  });

  it('executes the cron prompt before marking the job successful', async () => {
    const scheduler = new CronScheduler({
      runtimeDir: tempDir,
      bridge: mockBridge,
      enabled: true,
    });

    const job = scheduler.addJob({
      name: 'Run prompt',
      schedule: '0 9 * * *',
      channelType: 'telegram',
      chatId: 'test-chat-123',
      prompt: 'summarize the repo status',
      enabled: true,
    });

    await (scheduler as any).executeJob(job);

    expect(mockBridge.injectAutomationPrompt).toHaveBeenCalledWith(expect.objectContaining({
      channelType: 'telegram',
      chatId: 'test-chat-123',
      text: 'summarize the repo status',
      userId: 'cron',
    }));
    expect(job.lastResult).toBe('success');
    expect(job.lastRun).toBeDefined();
  });
});
