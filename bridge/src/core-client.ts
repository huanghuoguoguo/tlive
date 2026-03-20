const HEALTH_CHECK_INTERVAL_MS = 30_000;

export class CoreClientImpl {
  private baseUrl: string;
  private token: string;
  private healthy = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  async connect(): Promise<void> {
    // Just check if Go Core is reachable
    const status = await this.request('GET', '/api/status');
    if (!status) throw new Error('Go Core not reachable');
    this.healthy = true;

    // Periodic health check
    this.healthCheckInterval = setInterval(async () => {
      try {
        await this.request('GET', '/api/status');
        this.healthy = true;
      } catch {
        this.healthy = false;
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  async disconnect(): Promise<void> {
    if (this.healthCheckInterval !== null) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    this.healthy = false;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- return type used by tests and callers that access arbitrary session properties
  async listSessions(): Promise<any[]> {
    return this.request('GET', '/api/sessions') as Promise<any[]>;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Core API error: ${res.status} ${res.statusText}`);
    const contentType = res.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      return res.json();
    }
  }
}
