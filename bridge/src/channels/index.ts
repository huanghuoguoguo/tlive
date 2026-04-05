// Dynamic import for adapters — only load what's configured
// This reduces memory usage from ~180MB to ~60MB by not loading unused IM SDKs

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export { BaseChannelAdapter, createAdapter, registerAdapterFactory, getRegisteredTypes } from './base.js';
export type { ChannelType, InboundMessage, OutboundMessage, SendResult, Button, FileAttachment } from './types.js';

// Dynamic adapter loader — called by main.ts after config is loaded
export async function loadAdapters(enabledChannels: string[]): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const importPromises: Promise<void>[] = [];

  // Import from dist/channels/*.mjs (built separately for lazy loading)
  if (enabledChannels.includes('telegram')) {
    importPromises.push(import(join(__dirname, 'channels', 'telegram.mjs')).then(() => {}));
  }
  if (enabledChannels.includes('discord')) {
    importPromises.push(import(join(__dirname, 'channels', 'discord.mjs')).then(() => {}));
  }
  if (enabledChannels.includes('feishu')) {
    importPromises.push(import(join(__dirname, 'channels', 'feishu.mjs')).then(() => {}));
  }
  if (enabledChannels.includes('qqbot')) {
    importPromises.push(import(join(__dirname, 'channels', 'qqbot.mjs')).then(() => {}));
  }

  await Promise.all(importPromises);
}
