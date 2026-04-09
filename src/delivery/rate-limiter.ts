export class ChatRateLimiter {
  private limit: number;
  private windowMs: number;
  private buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  tryConsume(chatId: string): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(chatId);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(chatId, bucket);
    }
    if (bucket.count >= this.limit) return false;
    bucket.count++;
    return true;
  }
}
