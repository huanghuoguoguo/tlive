import { describe, expect, it, vi } from 'vitest';
import { feishuMessageEventToInbound } from '../../server/channels/feishu/inbound.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const GIF = Buffer.from('GIF89a....', 'ascii');
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x0a, 0, 0, 0]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.from([1, 2, 3]),
]);

type FeishuClient = Parameters<typeof feishuMessageEventToInbound>[1];

function clientReturning(buf: Buffer | null): FeishuClient {
  return {
    im: {
      messageResource: { get: vi.fn(async () => buf) },
      image: { get: vi.fn(async () => buf) },
      v1: { messageResource: { get: vi.fn(async () => buf) } },
    },
  };
}

function imageEvent(imageKey: string) {
  return {
    sender: { sender_id: { open_id: 'ou_sender' } },
    message: {
      message_type: 'image',
      content: JSON.stringify({ image_key: imageKey }),
      chat_id: 'oc_chat',
      chat_type: 'p2p',
      message_id: 'om_msg',
    },
  };
}

describe('feishuMessageEventToInbound image attachments', () => {
  it('declares the type the bytes actually are, not the png the API implies', async () => {
    const cases: Array<[Buffer, string, string]> = [
      [PNG, 'image/png', 'image.png'],
      [JPEG, 'image/jpeg', 'image.jpg'],
      [GIF, 'image/gif', 'image.gif'],
      [WEBP, 'image/webp', 'image.webp'],
    ];

    for (const [buf, mimeType, name] of cases) {
      const msg = await feishuMessageEventToInbound(imageEvent('img_key'), clientReturning(buf));

      expect(msg?.attachments?.[0]).toMatchObject({ type: 'image', mimeType, name });
      expect(msg?.attachments?.[0]?.base64Data).toBe(buf.toString('base64'));
    }
  });

  it('falls back to png when the bytes carry no known signature', async () => {
    const msg = await feishuMessageEventToInbound(
      imageEvent('img_key'),
      clientReturning(Buffer.from([1, 2, 3, 4, 5])),
    );

    expect(msg?.attachments?.[0]).toMatchObject({ mimeType: 'image/png', name: 'image.png' });
  });

  it('tells the log when an image is too large to forward', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const oversized = Buffer.concat([PNG, Buffer.alloc(10_000_001)]);

    const msg = await feishuMessageEventToInbound(imageEvent('img_key'), clientReturning(oversized));

    expect(msg).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeds the 10MB inbound limit'));
    warn.mockRestore();
  });
});
