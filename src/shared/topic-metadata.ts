import type { AgentProviderKind } from './providers/kinds.js';

const TOPIC_METADATA_PREFIX = 'tlive-topic:';
const TOPIC_METADATA_PATTERN = /tlive-topic:([A-Za-z0-9_-]+)/;
const VISIBLE_TOPIC_METADATA_PATTERN = /\u2063tlive-topic:([A-Za-z0-9_-]+)\u2063/;
const LEGACY_TOPIC_METADATA_PATTERN = /<!--\s*tlive-topic:([A-Za-z0-9_-]+)\s*-->/;

export interface TliveTopicMetadata {
  type: 'tlive.topic';
  version: 1;
  provider?: AgentProviderKind;
  clientId?: string;
  cwd?: string;
  sdkSessionId?: string;
  threadId?: string;
  rootMessageId?: string;
  entryMessageId?: string;
  title?: string;
  preview?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type TliveTopicMetadataInput = Omit<TliveTopicMetadata, 'type' | 'version'> &
  Partial<Pick<TliveTopicMetadata, 'type' | 'version'>>;

export function buildTliveTopicMetadata(input: TliveTopicMetadataInput): TliveTopicMetadata {
  const metadata: TliveTopicMetadata = {
    type: 'tlive.topic',
    version: 1,
  };

  assignString(metadata, 'provider', readProvider(input.provider));
  assignString(metadata, 'clientId', input.clientId);
  assignString(metadata, 'cwd', input.cwd);
  assignString(metadata, 'sdkSessionId', input.sdkSessionId);
  assignString(metadata, 'threadId', input.threadId);
  assignString(metadata, 'rootMessageId', input.rootMessageId);
  assignString(metadata, 'entryMessageId', input.entryMessageId);
  assignString(metadata, 'title', input.title);
  assignString(metadata, 'preview', input.preview);
  assignString(metadata, 'createdAt', input.createdAt);
  assignString(metadata, 'updatedAt', input.updatedAt);

  return metadata;
}

export function encodeTliveTopicMetadata(input: TliveTopicMetadataInput): string {
  const json = JSON.stringify(buildTliveTopicMetadata(input));
  return `${TOPIC_METADATA_PREFIX}${Buffer.from(json, 'utf8').toString('base64url')}`;
}

export function withTliveTopicMetadata(
  visibleText: string,
  metadata: TliveTopicMetadataInput,
): string {
  const text = stripTliveTopicMetadata(visibleText).trimEnd();
  return `${text}\n\n${encodeTliveTopicMetadata(metadata)}`;
}

export function stripTliveTopicMetadata(text: string): string {
  return text
    .replace(TOPIC_METADATA_PATTERN, '')
    .replace(VISIBLE_TOPIC_METADATA_PATTERN, '')
    .replace(LEGACY_TOPIC_METADATA_PATTERN, '')
    .trim();
}

export function extractTliveTopicMetadata(text: string): TliveTopicMetadata | undefined {
  const encoded =
    text.match(TOPIC_METADATA_PATTERN)?.[1] ??
    text.match(VISIBLE_TOPIC_METADATA_PATTERN)?.[1] ??
    text.match(LEGACY_TOPIC_METADATA_PATTERN)?.[1];
  if (!encoded) return undefined;

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return parseTliveTopicMetadata(parsed);
  } catch {
    return undefined;
  }
}

export function findTliveTopicMetadata(value: unknown): TliveTopicMetadata | undefined {
  if (typeof value === 'string') {
    return extractTliveTopicMetadata(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const metadata = findTliveTopicMetadata(item);
      if (metadata) return metadata;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;

  for (const item of Object.values(value)) {
    const metadata = findTliveTopicMetadata(item);
    if (metadata) return metadata;
  }
  return undefined;
}

function parseTliveTopicMetadata(value: unknown): TliveTopicMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (input.type !== 'tlive.topic' || input.version !== 1) return undefined;

  return buildTliveTopicMetadata({
    provider: readProvider(input.provider),
    clientId: readString(input.clientId),
    cwd: readString(input.cwd),
    sdkSessionId: readString(input.sdkSessionId),
    threadId: readString(input.threadId),
    rootMessageId: readString(input.rootMessageId),
    entryMessageId: readString(input.entryMessageId),
    title: readString(input.title),
    preview: readString(input.preview),
    createdAt: readString(input.createdAt),
    updatedAt: readString(input.updatedAt),
  });
}

function readProvider(value: unknown): AgentProviderKind | undefined {
  return value === 'claude' || value === 'codex' || value === 'pi' ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function assignString<TKey extends keyof TliveTopicMetadata>(
  target: TliveTopicMetadata,
  key: TKey,
  value: TliveTopicMetadata[TKey] | undefined,
): void {
  if (typeof value === 'string' && value.trim()) {
    target[key] = value.trim() as TliveTopicMetadata[TKey];
  }
}
