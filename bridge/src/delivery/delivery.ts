import type { BaseChannelAdapter } from '../channels/base.js';
import type { OutboundMessage } from '../channels/types.js';
import { BridgeError, RateLimitError } from '../channels/errors.js';
import { ChatRateLimiter } from './rate-limiter.js';

interface DeliveryOptions {
  platformLimit?: number;
  maxRetries?: number;
  interChunkDelayMs?: number;
  /** Use paragraph-aware chunking (default: true) */
  paragraphChunk?: boolean;
}

/**
 * Split text by paragraph boundaries (double newlines) first, then by length.
 * Keeps paragraphs together when possible for better readability.
 */
export function chunkByParagraph(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const addition = current ? '\n\n' + para : para;
    if (current && current.length + addition.length > limit) {
      chunks.push(current);
      // If single paragraph exceeds limit, fall through to chunkMarkdown
      current = para;
    } else {
      current += addition;
    }
  }
  if (current) chunks.push(current);

  // Second pass: any chunk still over limit gets split by chunkMarkdown
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= limit) {
      result.push(chunk);
    } else {
      result.push(...chunkMarkdown(chunk, limit));
    }
  }

  // Third pass: merge tiny trailing fragments into previous chunk
  const MIN_CHUNK = 80;
  const merged: string[] = [];
  for (const chunk of result) {
    if (merged.length > 0 && chunk.length < MIN_CHUNK && merged[merged.length - 1].length + chunk.length + 2 <= limit) {
      merged[merged.length - 1] += '\n\n' + chunk;
    } else {
      merged.push(chunk);
    }
  }
  return merged;
}

export function chunkMarkdown(text: string, limit: number, maxLines?: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  const lines = text.split('\n');
  let current = '';
  let inCodeBlock = false;
  let fenceLang = '';

  const flush = () => {
    if (!current) return;
    if (inCodeBlock) {
      chunks.push(current + '\n```');
    } else {
      chunks.push(current);
    }
    current = '';
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^(```+)(.*)/);
    const isFence = !!fenceMatch;

    const separator = current ? '\n' : '';
    const addition = separator + line;
    const lineCount = current.split('\n').length;
    const wouldExceed = current.length + addition.length + (inCodeBlock ? 4 : 0) > limit
      || (maxLines && lineCount >= maxLines && current.length > 0);

    if (wouldExceed && current) {
      flush();
      if (inCodeBlock) {
        current = '```' + fenceLang + '\n' + line;
      } else {
        current = line;
      }
    } else {
      current += addition;
    }

    if (isFence) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        fenceLang = fenceMatch![2] || '';
      } else {
        inCodeBlock = false;
        fenceLang = '';
      }
    }
  }

  if (current) chunks.push(current);

  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= limit) {
      result.push(chunk);
    } else {
      let remaining = chunk;
      // Detect if this chunk is inside a code block (starts with ``` fence)
      const startsWithFence = /^```/.test(remaining);
      const insideFence = startsWithFence;

      while (remaining.length > limit) {
        let slice = remaining.slice(0, limit);
        remaining = remaining.slice(limit);

        if (insideFence) {
          // Count fences in the slice to track state
          const fences = (slice.match(/```/g) || []).length;
          const openAtEnd = (startsWithFence ? fences : fences + 1) % 2 !== 0;
          if (openAtEnd && remaining.length > 0) {
            // Close the fence in this slice, reopen in the next
            const closeTag = '\n```';
            slice = slice.slice(0, limit - closeTag.length) + closeTag;
            remaining = '```\n' + remaining;
          }
        }

        result.push(slice);
      }
      if (remaining) result.push(remaining);
    }
  }
  return result;
}

export class DeliveryLayer {
  private rateLimiter = new ChatRateLimiter(20, 60_000);

  async deliver(
    adapter: BaseChannelAdapter,
    chatId: string,
    text: string,
    options: DeliveryOptions = {}
  ): Promise<void> {
    const { platformLimit = 4096, maxRetries = 3, interChunkDelayMs = 300, paragraphChunk = true } = options;
    const chunks = paragraphChunk
      ? chunkByParagraph(text, platformLimit)
      : this.chunk(text, platformLimit);

    for (let i = 0; i < chunks.length; i++) {
      // Rate limit
      while (!this.rateLimiter.tryConsume(chatId)) {
        await new Promise(r => setTimeout(r, 1000));
      }

      await this.sendWithRetry(adapter, { chatId, text: chunks[i] }, maxRetries);

      if (i < chunks.length - 1) {
        await new Promise(r => setTimeout(r, interChunkDelayMs));
      }
    }
  }

  private async sendWithRetry(
    adapter: BaseChannelAdapter,
    message: OutboundMessage,
    maxRetries: number
  ): Promise<void> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await adapter.send(message);
        return;
      } catch (err) {
        lastError = err as Error;
        // Don't retry non-retryable errors
        if (err instanceof BridgeError && !err.retryable) throw err;
        if (attempt < maxRetries - 1) {
          const baseDelay = Math.min(1000 * 2 ** attempt, 10_000);
          // Add jitter (±25%) to avoid thundering herd
          const jitter = baseDelay * (0.75 + Math.random() * 0.5);
          const delay = (err instanceof RateLimitError && err.retryAfterMs > 0)
            ? Math.max(err.retryAfterMs, jitter)
            : jitter;
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  }

  private chunk(text: string, limit: number): string[] {
    return chunkMarkdown(text, limit);
  }
}
