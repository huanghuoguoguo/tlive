import type { Readable } from 'node:stream';

/**
 * Read a Feishu SDK response into a Buffer.
 *
 * Different SDK endpoints/versions return Buffer, ArrayBuffer, readable streams,
 * async iterables, or helper objects with writeFile/getReadableStream.
 */
export async function readFeishuBuffer(resp: unknown): Promise<Buffer | null> {
  if (!resp) return null;
  const r = resp as any;

  if (Buffer.isBuffer(r)) return r;
  if (r instanceof ArrayBuffer) return Buffer.from(r);
  if (r.data && Buffer.isBuffer(r.data)) return r.data;
  if (r.data instanceof ArrayBuffer) return Buffer.from(r.data);

  if (typeof r.getReadableStream === 'function') {
    return readChunks(r.getReadableStream());
  }

  if (typeof r.writeFile === 'function') {
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { readFile, unlink } = await import('node:fs/promises');
    const tmp = join(tmpdir(), `tlive-feishu-${Date.now()}.tmp`);
    try {
      await r.writeFile(tmp);
      return await readFile(tmp);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }

  if (typeof r.data?.[Symbol.asyncIterator] === 'function') {
    return readChunks(r.data as AsyncIterable<Buffer>);
  }
  if (typeof r[Symbol.asyncIterator] === 'function') {
    return readChunks(r as AsyncIterable<Buffer>);
  }
  if (typeof r.data?.read === 'function') {
    return readChunks(r.data as Readable);
  }

  return null;
}

export function getFeishuUploadKey(
  result: unknown,
  key: 'file_key' | 'image_key',
): string | undefined {
  const record = result as Record<string, unknown> | null | undefined;
  const direct = record?.[key];
  if (typeof direct === 'string' && direct) return direct;

  const nested = (record?.data as Record<string, unknown> | null | undefined)?.[key];
  if (typeof nested === 'string' && nested) return nested;

  return undefined;
}

async function readChunks(iterable: AsyncIterable<Buffer | Uint8Array | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of iterable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
