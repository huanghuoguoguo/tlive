import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preparePromptWithFileAttachments } from '../../server/engine/conversation-engine.js';
import type { FileAttachment } from '../../shared/providers/base.js';

function tempTliveHome(): string {
  return join(tmpdir(), `tlive-conversation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

describe('preparePromptWithFileAttachments', () => {
  const previousTliveHome = process.env.TLIVE_HOME;
  let tliveHome = '';

  afterEach(() => {
    if (tliveHome) {
      rmSync(tliveHome, { recursive: true, force: true });
      tliveHome = '';
    }
    if (previousTliveHome === undefined) {
      delete process.env.TLIVE_HOME;
    } else {
      process.env.TLIVE_HOME = previousTliveHome;
    }
  });

  it('persists binary files and references the local path in the prompt', () => {
    tliveHome = tempTliveHome();
    process.env.TLIVE_HOME = tliveHome;
    const attachment: FileAttachment = {
      type: 'file',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      base64Data: Buffer.from('%PDF test').toString('base64'),
    };

    const prompt = preparePromptWithFileAttachments('summarize this', [attachment]);
    const path = prompt.match(/Path: `([^`]+)`/)?.[1];

    expect(prompt).toContain('summarize this');
    expect(prompt).toContain('report.pdf');
    expect(path).toBeTruthy();
    expect(path).toContain(join(tliveHome, 'attachments'));
    expect(existsSync(path!)).toBe(true);
    expect(readFileSync(path!, 'utf-8')).toBe('%PDF test');
  });

  it('inlines small text files while still giving Claude a file path', () => {
    tliveHome = tempTliveHome();
    process.env.TLIVE_HOME = tliveHome;
    const attachment: FileAttachment = {
      type: 'file',
      name: 'notes.txt',
      mimeType: 'application/octet-stream',
      base64Data: Buffer.from('hello notes').toString('base64'),
    };

    const prompt = preparePromptWithFileAttachments('', [attachment]);

    expect(prompt).toContain('[File: notes.txt (text/plain)]');
    expect(prompt).toContain('Path: `');
    expect(prompt).toContain('hello notes');
  });

  it('persists images and gives the agent a path it can re-open in a later turn', () => {
    tliveHome = tempTliveHome();
    process.env.TLIVE_HOME = tliveHome;
    const attachment: FileAttachment = {
      type: 'image',
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      base64Data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64'),
    };

    const prompt = preparePromptWithFileAttachments('look', [attachment]);
    const path = prompt.match(/Path: `([^`]+)`/)?.[1];

    expect(prompt).toContain('[Image: photo.jpg (image/jpeg)');
    expect(path).toContain(join(tliveHome, 'attachments'));
    expect(existsSync(path!)).toBe(true);
    // Written back so the provider leg reuses this copy instead of staging a second one.
    expect(attachment.localPath).toBe(path);
  });

  it('keeps an existing localPath instead of writing the image again', () => {
    tliveHome = tempTliveHome();
    process.env.TLIVE_HOME = tliveHome;
    const attachment: FileAttachment = {
      type: 'image',
      name: 'photo.png',
      mimeType: 'image/png',
      base64Data: Buffer.from('not an image').toString('base64'),
      localPath: '/already/persisted.png',
    };

    const prompt = preparePromptWithFileAttachments('look', [attachment]);

    expect(prompt).toContain('Path: `/already/persisted.png`');
    expect(attachment.localPath).toBe('/already/persisted.png');
  });
});
