import { randomBytes } from 'node:crypto';
import type { DeliveryRoute, FileDeliveryRoute } from '../../channels/delivery-route.js';

interface FileDeliveryRouteEntry {
  route: FileDeliveryRoute;
  createdAt: number;
}

export interface FileDeliveryRegistryOptions {
  ttlMs?: number;
  now?: () => number;
  generateToken?: () => string;
}

export class FileDeliveryRegistry {
  static readonly DEFAULT_ROUTE_TTL_MS = 6 * 60 * 60 * 1000;

  private routes = new Map<string, FileDeliveryRouteEntry>();
  private ttlMs: number;
  private now: () => number;
  private generateToken: () => string;

  constructor(options: FileDeliveryRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? FileDeliveryRegistry.DEFAULT_ROUTE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.generateToken = options.generateToken ?? (() => randomBytes(18).toString('base64url'));
  }

  register(sessionKey: string, route: DeliveryRoute, cwd: string): string {
    this.prune();
    const token = this.nextToken();
    this.routes.set(token, {
      route: { ...route, cwd, sessionKey },
      createdAt: this.now(),
    });
    return token;
  }

  resolve(token: string): FileDeliveryRoute | undefined {
    this.prune();
    return this.routes.get(token)?.route;
  }

  consume(token: string): FileDeliveryRoute | undefined {
    this.prune();
    const entry = this.routes.get(token);
    if (!entry) return undefined;
    this.routes.delete(token);
    return entry.route;
  }

  prune(now = this.now()): void {
    for (const [token, entry] of this.routes) {
      if (now - entry.createdAt > this.ttlMs) {
        this.routes.delete(token);
      }
    }
  }

  private nextToken(): string {
    let token = this.generateToken();
    while (this.routes.has(token)) {
      token = this.generateToken();
    }
    return token;
  }
}
