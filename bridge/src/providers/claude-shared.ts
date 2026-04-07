/**
 * Shared code between ClaudeSDKProvider and ClaudeLiveSession.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import type { FileAttachment } from './base.js';

// ── Environment isolation ──

const ENV_ALWAYS_STRIP = ['CLAUDECODE'];

export function buildSubprocessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (ENV_ALWAYS_STRIP.some(prefix => k.startsWith(prefix))) continue;
    out[k] = v;
  }
  return out;
}

// ── Safe permissions for initial settings ──

export const SAFE_PERMISSIONS = [
  'Bash(safe *)',
  'Read(*)',
  'Write(*)',
  'Edit(*)',
  'Glob(*)',
  'Grep(*)',
  'NotebookEdit(*)',
  'WebFetch(domain:*)',
  'WebSearch',
  'Task(*)',
  'ExitPlanMode',
  'ToolSearch',
];

// ── Prompt preparation with images ──

/**
 * Prepare prompt with image attachments.
 * Images are saved to temp files and referenced by path.
 */
export function preparePromptWithImages(
  prompt: string,
  attachments?: FileAttachment[],
  tmpImageDir?: string,
): { prompt: string; imagePaths: string[] } {
  if (!attachments?.length) {
    return { prompt, imagePaths: [] };
  }

  const imagePaths: string[] = [];
  const imgDir = tmpImageDir || join(homedir(), '.tlive', 'tmp-images');

  try {
    mkdirSync(imgDir, { recursive: true });
    for (const att of attachments) {
      if (att.type === 'image') {
        const ext = att.mimeType === 'image/png' ? '.png'
          : att.mimeType === 'image/gif' ? '.gif'
          : '.jpg';
        const filePath = join(imgDir, `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`);
        writeFileSync(filePath, Buffer.from(att.base64Data, 'base64'));
        imagePaths.push(filePath);
      }
    }
  } catch {
    // Ignore errors creating directory or writing files
  }

  if (imagePaths.length > 0) {
    const imageRefs = imagePaths.join('\n');
    prompt = `[User sent ${imagePaths.length} image(s) — read them to see the content]\n${imageRefs}\n\n${prompt}`;
  }

  return { prompt, imagePaths };
}

// ── Types ──

/** Called when a permission request times out */
export type PermissionTimeoutCallback = (toolName: string, toolUseId: string) => void;