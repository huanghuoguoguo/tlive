/**
 * Cron Scheduler — Phase 3 automation entry.
 *
 * Provides scheduled task execution for tlive:
 * - Cron expression parsing (basic support)
 * - Job persistence (JSON file)
 * - Session lifecycle handling
 *
 * Design considerations:
 * - Jobs are persisted to survive restarts
 * - Failed jobs are logged but not auto-retried (Phase 3 simplicity)
 * - Jobs require explicit target (channelType + chatId) or projectName
 * - Only 'prompt' is supported (no exec by default)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BridgeManager } from './bridge-manager.js';
import { loadProjectsConfig, type ClaudeSettingSource } from '../config.js';

/** Cron job definition */
export interface CronJob {
  /** Unique job ID */
  id: string;
  /** Human-readable job name */
  name: string;
  /** Cron expression (e.g., '0 9 * * 1-5' = 9am weekdays) */
  schedule: string;
  /** Target channel type (required if projectName not specified) */
  channelType?: string;
  /** Target chat ID (required if projectName not specified) */
  chatId?: string;
  /** Project name for routing (alternative to channelType + chatId) */
  projectName?: string;
  /** Prompt to send to Claude */
  prompt: string;
  /** Event name for IM feedback display */
  event?: string;
  /** Whether job is enabled */
  enabled: boolean;
  /** Last run timestamp (epoch ms) */
  lastRun?: number;
  /** Next scheduled run timestamp (epoch ms) */
  nextRun?: number;
  /** Last run result */
  lastResult?: 'success' | 'failed' | 'skipped';
  /** Last error message (if failed) */
  lastError?: string;
  /** Created timestamp */
  createdAt: number;
  /** Updated timestamp */
  updatedAt: number;
}

/** Cron scheduler configuration */
export interface CronSchedulerOptions {
  /** Runtime directory for persistence */
  runtimeDir: string;
  /** Bridge manager for message delivery */
  bridge: BridgeManager;
  /** Enable cron scheduler (default: false) */
  enabled: boolean;
}

/** Persisted cron jobs file structure */
interface CronJobsFile {
  jobs: CronJob[];
  version: number;
}

/**
 * Parse a cron expression into runnable intervals.
 *
 * Supported format: `minute hour day month weekday`
 * - minute: 0-59 or *
 * - hour: 0-23 or *
 * - day: 1-31 or *
 * - month: 1-12 or *
 * - weekday: 0-6 (Sunday=0) or *
 *
 * Note: This is a simplified parser. For full cron support,
 * consider using a library like 'node-cron' in production.
 */
export function parseCronExpression(expression: string): {
  minute: number | '*';
  hour: number | '*';
  day: number | '*';
  month: number | '*';
  weekday: number | '*';
} | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const parsePart = (part: string, min: number, max: number): number | '*' => {
    if (part === '*') return '*';
    const num = parseInt(part, 10);
    if (Number.isNaN(num) || num < min || num > max) return null as any;
    return num;
  };

  const minute = parsePart(parts[0], 0, 59);
  const hour = parsePart(parts[1], 0, 23);
  const day = parsePart(parts[2], 1, 31);
  const month = parsePart(parts[3], 1, 12);
  const weekday = parsePart(parts[4], 0, 6);

  // Validation
  if (minute === null as any || hour === null as any || day === null as any ||
      month === null as any || weekday === null as any) {
    return null;
  }

  return { minute, hour, day, month, weekday };
}

/**
 * Calculate next run time from a cron expression.
 * Returns timestamp in milliseconds, or null if expression is invalid.
 */
export function calculateNextRun(expression: string, fromTime?: number): number | null {
  const parsed = parseCronExpression(expression);
  if (!parsed) return null;

  const now = fromTime ?? Date.now();
  const fromDate = new Date(now);

  // Simple algorithm: iterate through minutes until we find a match
  // This is not optimal but works for basic expressions
  // For production, consider a proper cron library

  const candidate = new Date(fromDate);
  candidate.setSeconds(0);
  candidate.setMilliseconds(0);

  // Skip current minute
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Search up to 366 days (safety limit)
  const maxIterations = 366 * 24 * 60;
  for (let i = 0; i < maxIterations; i++) {
    const matches =
      (parsed.minute === '*' || candidate.getMinutes() === parsed.minute) &&
      (parsed.hour === '*' || candidate.getHours() === parsed.hour) &&
      (parsed.day === '*' || candidate.getDate() === parsed.day) &&
      (parsed.month === '*' || (candidate.getMonth() + 1) === parsed.month) &&
      (parsed.weekday === '*' || candidate.getDay() === parsed.weekday);

    if (matches) {
      return candidate.getTime();
    }

    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null; // No match found within limit
}

/**
 * Generate a unique job ID.
 */
function generateJobId(): string {
  return `cron-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function calculateNextRunOrUndefined(expression: string, fromTime?: number): number | undefined {
  return calculateNextRun(expression, fromTime) ?? undefined;
}

/**
 * Cron Scheduler — manages scheduled jobs and triggers prompts.
 *
 * Phase 3 implementation:
 * - Basic cron expression parsing
 * - JSON file persistence
 * - Simple tick-based scheduling (1-minute intervals)
 * - No auto-retry on failure
 */
export class CronScheduler {
  private jobs: Map<string, CronJob> = new Map();
  private persistPath: string;
  private bridge: BridgeManager;
  private enabled: boolean;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: CronSchedulerOptions) {
    this.persistPath = join(options.runtimeDir, 'cron-jobs.json');
    this.bridge = options.bridge;
    this.enabled = options.enabled;

    if (this.enabled) {
      this.loadJobs();
    }
  }

  /**
   * Start the scheduler tick loop.
   * Runs every minute to check for jobs to execute.
   */
  start(): void {
    if (!this.enabled || this.running) return;

    this.running = true;
    console.log('[cron] Scheduler started');

    // Initial check
    this.tick();

    // Schedule tick every minute
    this.tickTimer = setInterval(() => this.tick(), 60_000);
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.running = false;
    console.log('[cron] Scheduler stopped');
  }

  /**
   * Tick — check all jobs and execute any that are due.
   */
  private tick(): void {
    const now = Date.now();

    for (const [, job] of this.jobs) {
      if (!job.enabled) continue;

      // Update nextRun if not set
      if (!job.nextRun) {
        job.nextRun = calculateNextRunOrUndefined(job.schedule, now);
        this.saveJobs();
      }

      // Check if job is due
      if (job.nextRun && job.nextRun <= now) {
        this.executeJob(job);
      }
    }
  }

  /**
   * Execute a cron job — deliver the prompt to the target.
   */
  private async executeJob(job: CronJob): Promise<void> {
    console.log(`[cron] Executing job: ${job.id} (${job.name})`);

    try {
      const route = this.resolveJobTarget(job);
      if (!route) {
        console.warn(`[cron] No target available for job ${job.id}`);
        job.lastResult = 'skipped';
        job.lastError = 'No target chat available';
        job.lastRun = Date.now();
        job.nextRun = calculateNextRunOrUndefined(job.schedule);
        this.saveJobs();
        return;
      }

      const { adapter, channelType, chatId, workdir, projectName, claudeSettingSources } = route;

      // Send feedback to IM
      const eventLabel = job.event || 'Scheduled task';
      await adapter.send({
        chatId,
        text: `⏰ Cron: ${eventLabel}\n${job.prompt.slice(0, 100)}${job.prompt.length > 100 ? '...' : ''}`,
      }).catch(err => {
        console.warn(`[cron] Failed to send feedback: ${err}`);
      });

      await this.bridge.injectAutomationPrompt({
        channelType,
        chatId,
        text: job.prompt,
        messageId: `cron-${job.id}-${Date.now().toString(36)}`,
        userId: 'cron',
        workdir,
        projectName,
        claudeSettingSources,
      });

      // Mark success
      job.lastResult = 'success';
      job.lastError = undefined;
      job.lastRun = Date.now();
      job.nextRun = calculateNextRunOrUndefined(job.schedule);
      this.saveJobs();

      console.log(`[cron] Job ${job.id} completed successfully`);
    } catch (err) {
      console.error(`[cron] Job ${job.id} failed:`, err);
      job.lastResult = 'failed';
      job.lastError = err instanceof Error ? err.message : 'Unknown error';
      job.lastRun = Date.now();
      job.nextRun = calculateNextRunOrUndefined(job.schedule);
      this.saveJobs();
    }
  }

  private resolveJobTarget(job: CronJob): {
    adapter: NonNullable<ReturnType<BridgeManager['getAdapter']>>;
    channelType: string;
    chatId: string;
    workdir?: string;
    projectName?: string;
    claudeSettingSources?: ClaudeSettingSource[];
  } | null {
    if (job.channelType) {
      const adapter = this.bridge.getAdapter(job.channelType);
      if (!adapter) {
        return null;
      }

      const chatId = job.chatId || this.bridge.getLastChatId(job.channelType);
      if (!chatId) {
        return null;
      }

      return {
        adapter,
        channelType: job.channelType,
        chatId,
      };
    }

    if (job.projectName) {
      const project = loadProjectsConfig()?.valid.find(candidate => candidate.name === job.projectName);
      if (!project) {
        return null;
      }

      if (project.webhookDefaultChat) {
        const adapter = this.bridge.getAdapter(project.webhookDefaultChat.channelType);
        if (!adapter) {
          return null;
        }

        return {
          adapter,
          channelType: project.webhookDefaultChat.channelType,
          chatId: project.webhookDefaultChat.chatId,
          workdir: project.workdir,
          projectName: project.name,
          claudeSettingSources: project.claudeSettingSources,
        };
      }

      const enabledChannels = project.channels || this.bridge.getAdapters().map(adapter => adapter.channelType);
      for (const channelType of enabledChannels) {
        const adapter = this.bridge.getAdapter(channelType);
        const chatId = this.bridge.getLastChatId(channelType);
        if (adapter && chatId) {
          return {
            adapter,
            channelType,
            chatId,
            workdir: project.workdir,
            projectName: project.name,
            claudeSettingSources: project.claudeSettingSources,
          };
        }
      }

      return null;
    }

    const adapter = this.bridge.getAdapters()[0];
    if (!adapter) {
      return null;
    }

    const chatId = this.bridge.getLastChatId(adapter.channelType);
    if (!chatId) {
      return null;
    }

    return {
      adapter,
      channelType: adapter.channelType,
      chatId,
    };
  }

  // ── Job Management API ──

  /**
   * Add a new cron job.
   */
  addJob(job: Omit<CronJob, 'id' | 'createdAt' | 'updatedAt' | 'nextRun'>): CronJob {
    const id = generateJobId();
    const now = Date.now();

    // Validate schedule
    const parsed = parseCronExpression(job.schedule);
    if (!parsed) {
      throw new Error(`Invalid cron expression: ${job.schedule}`);
    }

    const newJob: CronJob = {
      ...job,
      id,
      createdAt: now,
      updatedAt: now,
      nextRun: calculateNextRunOrUndefined(job.schedule, now),
    };

    this.jobs.set(id, newJob);
    this.saveJobs();

    console.log(`[cron] Added job: ${id} (${job.name})`);
    return newJob;
  }

  /**
   * Update an existing cron job.
   */
  updateJob(id: string, updates: Partial<Omit<CronJob, 'id' | 'createdAt'>>): CronJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;

    // Validate schedule if changed
    if (updates.schedule) {
      const parsed = parseCronExpression(updates.schedule);
      if (!parsed) {
        throw new Error(`Invalid cron expression: ${updates.schedule}`);
      }
    }

    Object.assign(job, updates, { updatedAt: Date.now() });

    // Recalculate nextRun if schedule changed
    if (updates.schedule || updates.enabled === true) {
      job.nextRun = calculateNextRunOrUndefined(job.schedule);
    }

    this.saveJobs();
    console.log(`[cron] Updated job: ${id}`);
    return job;
  }

  /**
   * Remove a cron job.
   */
  removeJob(id: string): boolean {
    if (!this.jobs.has(id)) return false;
    this.jobs.delete(id);
    this.saveJobs();
    console.log(`[cron] Removed job: ${id}`);
    return true;
  }

  /**
   * Get a specific job by ID.
   */
  getJob(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * List all jobs.
   */
  listJobs(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Enable/disable a job.
   */
  setJobEnabled(id: string, enabled: boolean): CronJob | null {
    return this.updateJob(id, { enabled });
  }

  // ── Persistence ──

  /**
   * Load jobs from JSON file.
   */
  private loadJobs(): void {
    if (!existsSync(this.persistPath)) return;

    try {
      const data: CronJobsFile = JSON.parse(readFileSync(this.persistPath, 'utf-8'));

      // Version check for future schema changes
      if (data.version !== 1) {
        console.warn(`[cron] Unknown jobs file version: ${data.version}`);
        return;
      }

      for (const job of data.jobs) {
        this.jobs.set(job.id, job);
      }

      console.log(`[cron] Loaded ${this.jobs.size} jobs from ${this.persistPath}`);

      // Recalculate nextRun for all jobs
      const now = Date.now();
      for (const job of this.jobs.values()) {
        if (job.enabled) {
          job.nextRun = calculateNextRunOrUndefined(job.schedule, now);
        }
      }
    } catch (err) {
      console.warn('[cron] Failed to load jobs:', err);
    }
  }

  /**
   * Save jobs to JSON file.
   */
  private saveJobs(): void {
    if (!this.enabled) return;

    const data: CronJobsFile = {
      jobs: Array.from(this.jobs.values()),
      version: 1,
    };

    try {
      mkdirSync(join(this.persistPath, '..'), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.warn('[cron] Failed to save jobs:', err);
    }
  }
}
