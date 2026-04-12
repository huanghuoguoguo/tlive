/**
 * Cron REST API handler — exposes CronScheduler CRUD over HTTP.
 *
 * Mounted on the webhook server under /api/cron/*.
 * The agent (Claude Code) can call these endpoints via WebFetch
 * to manage cron jobs on behalf of the user.
 *
 * Endpoints:
 *   GET    /api/cron/jobs          — list all jobs
 *   GET    /api/cron/jobs/:id      — get a specific job
 *   POST   /api/cron/jobs          — create a new job
 *   PUT    /api/cron/jobs/:id      — update a job
 *   DELETE /api/cron/jobs/:id      — delete a job
 *   POST   /api/cron/jobs/:id/enable  — enable a job
 *   POST   /api/cron/jobs/:id/disable — disable a job
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CronScheduler, CronJob } from './cron.js';

const API_PREFIX = '/api/cron/jobs';

interface RouteMatch {
  action: 'list' | 'get' | 'create' | 'update' | 'delete' | 'enable' | 'disable';
  jobId?: string;
}

function matchRoute(method: string, url: string): RouteMatch | null {
  // Strip query string
  const path = url.split('?')[0];

  if (path === API_PREFIX) {
    if (method === 'GET') return { action: 'list' };
    if (method === 'POST') return { action: 'create' };
    return null;
  }

  // /api/cron/jobs/:id/enable or /api/cron/jobs/:id/disable
  const toggleMatch = path.match(/^\/api\/cron\/jobs\/([^/]+)\/(enable|disable)$/);
  if (toggleMatch && method === 'POST') {
    return { action: toggleMatch[2] as 'enable' | 'disable', jobId: toggleMatch[1] };
  }

  // /api/cron/jobs/:id
  const idMatch = path.match(/^\/api\/cron\/jobs\/([^/]+)$/);
  if (idMatch) {
    const jobId = idMatch[1];
    if (method === 'GET') return { action: 'get', jobId };
    if (method === 'PUT') return { action: 'update', jobId };
    if (method === 'DELETE') return { action: 'delete', jobId };
    return null;
  }

  return null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    const maxSize = 16 * 1024; // 16KB

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error('Request body too large'));
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * Check if a request URL starts with the cron API prefix.
 */
export function isCronApiRequest(url: string): boolean {
  const path = url.split('?')[0];
  return path === API_PREFIX || path.startsWith(API_PREFIX + '/');
}

/**
 * Handle a cron API request.
 * Returns true if the request was handled, false if the route didn't match.
 */
export async function handleCronApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  scheduler: CronScheduler | null,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  const route = matchRoute(method, url);
  if (!route) {
    json(res, 405, { error: 'Method not allowed' });
    return true;
  }

  if (!scheduler) {
    json(res, 503, {
      error: 'Cron scheduler is not enabled. Set TL_CRON_ENABLED=true in config.',
    });
    return true;
  }

  try {
    switch (route.action) {
      case 'list': {
        const jobs = scheduler.listJobs();
        json(res, 200, { jobs });
        return true;
      }

      case 'get': {
        const job = scheduler.getJob(route.jobId!);
        if (!job) {
          json(res, 404, { error: `Job '${route.jobId}' not found` });
          return true;
        }
        json(res, 200, { job });
        return true;
      }

      case 'create': {
        const body = await readBody(req);
        const data = JSON.parse(body) as Partial<CronJob>;

        if (!data.name || !data.schedule || !data.prompt) {
          json(res, 400, { error: 'Missing required fields: name, schedule, prompt' });
          return true;
        }

        const job = scheduler.addJob({
          name: data.name,
          schedule: data.schedule,
          prompt: data.prompt,
          channelType: data.channelType,
          chatId: data.chatId,
          projectName: data.projectName,
          workdir: data.workdir,
          event: data.event,
          enabled: data.enabled ?? true,
        });

        json(res, 201, { job });
        return true;
      }

      case 'update': {
        const body = await readBody(req);
        const updates = JSON.parse(body) as Partial<CronJob>;

        const job = scheduler.updateJob(route.jobId!, updates);
        if (!job) {
          json(res, 404, { error: `Job '${route.jobId}' not found` });
          return true;
        }
        json(res, 200, { job });
        return true;
      }

      case 'delete': {
        const removed = scheduler.removeJob(route.jobId!);
        if (!removed) {
          json(res, 404, { error: `Job '${route.jobId}' not found` });
          return true;
        }
        json(res, 200, { success: true });
        return true;
      }

      case 'enable': {
        const job = scheduler.setJobEnabled(route.jobId!, true);
        if (!job) {
          json(res, 404, { error: `Job '${route.jobId}' not found` });
          return true;
        }
        json(res, 200, { job });
        return true;
      }

      case 'disable': {
        const job = scheduler.setJobEnabled(route.jobId!, false);
        if (!job) {
          json(res, 404, { error: `Job '${route.jobId}' not found` });
          return true;
        }
        json(res, 200, { job });
        return true;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message.includes('Invalid cron expression') ? 400 : 500;
    json(res, status, { error: message });
    return true;
  }

  return false;
}
