// Dynamic import for adapters — only load what's configured
// This reduces memory usage from ~180MB to ~60MB by not loading unused IM SDKs

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export { BaseChannelAdapter, createAdapter, registerAdapterFactory, getRegisteredTypes } from './base.js';
export type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  RenderedMessage,
  SendResult,
  FileAttachment,
  MediaAttachment,
  StreamingCardSession,
} from './types.js';
export type { Button } from '../ui/types.js';

// Re-export platform-specific types for convenience
export type { TelegramRenderedMessage } from './telegram/types.js';
export type { FeishuRenderedMessage } from './feishu/types.js';
export type { QQBotRenderedMessage } from './qqbot/types.js';

// Re-export formatters and adapters (for tests and legacy imports)
export { TelegramFormatter, TelegramAdapter } from './telegram/index.js';
export { FeishuFormatter, FeishuAdapter, buildFeishuCard, buildFeishuButtonElements, FeishuStreamingSession, FEISHU_POLICY } from './feishu/index.js';
export { QQBotFormatter, QQBotAdapter, QQBOT_POLICY } from './qqbot/index.js';

// Dynamic adapter loader — called by main.ts after config is loaded
export async function loadAdapters(enabledChannels: string[]): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const importPromises: Promise<void>[] = [];

  // Import from dist/channels/*.mjs (built separately for lazy loading)
  if (enabledChannels.includes('telegram')) {
    importPromises.push(import(join(__dirname, 'channels', 'telegram.mjs')).then(() => {}));
  }
  if (enabledChannels.includes('feishu')) {
    importPromises.push(import(join(__dirname, 'channels', 'feishu.mjs')).then(() => {}));
  }
  if (enabledChannels.includes('qqbot')) {
    importPromises.push(import(join(__dirname, 'channels', 'qqbot.mjs')).then(() => {}));
  }

  await Promise.all(importPromises);
}