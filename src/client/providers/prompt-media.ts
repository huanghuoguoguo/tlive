import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getTliveHome } from '../../shared/core/path.js';
import type { FileAttachment } from '../../shared/providers/types.js';

const EXT_BY_IMAGE_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

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
  const imgDir = tmpImageDir || join(getTliveHome(), 'tmp-images');
  let dirReady = false;

  for (const att of attachments) {
    if (att.type !== 'image') continue;
    // The bridge persists every inbound image and puts that path in the prompt, so reuse it
    // rather than writing a second copy that no one cleans up. Remote workers do not see the
    // bridge filesystem, which is why existence — not just presence — decides the reuse.
    if (att.localPath && existsSync(att.localPath)) {
      imagePaths.push(att.localPath);
      continue;
    }
    if (!att.base64Data) continue;
    try {
      if (!dirReady) {
        mkdirSync(imgDir, { recursive: true });
        dirReady = true;
      }
      const ext = EXT_BY_IMAGE_MIME[att.mimeType] || '.jpg';
      const digest = createHash('sha1').update(att.base64Data).digest('hex').slice(0, 12);
      const filePath = join(imgDir, `img-${digest}${ext}`);
      writeFileSync(filePath, Buffer.from(att.base64Data, 'base64'));
      imagePaths.push(filePath);
    } catch (err) {
      console.warn(
        `[prompt-media] could not stage "${att.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (imagePaths.length > 0) {
    const imageRefs = imagePaths.join('\n');
    prompt = `[User sent ${imagePaths.length} image(s) — read them to see the content]\n${imageRefs}\n\n${prompt}`;
  }

  return { prompt, imagePaths };
}
