import { z } from 'zod';
import { canonicalEventSchema, type CanonicalEvent } from '../canonical/schema.js';
import type { AgentProviderCapabilities } from '../providers/base.js';
import type { AgentProviderKind } from '../providers/kinds.js';
import type { AgentSettingSource } from '../config.js';
import { canonicalEffortSchema, type EffortLevel } from '../providers/effort.js';
import type { FileAttachment } from '../media/attachments.js';

export const REMOTE_PROTOCOL_VERSION = 1;

const providerKindSchema = z.enum(['claude', 'codex', 'pi']);
const settingSourceSchema = z.enum(['user', 'project', 'local']);

const providerCapabilitiesSchema = z.object({
  runtimeMode: z.enum(['interactive', 'turn-based']),
  nativeSteer: z.boolean(),
  nativeQueue: z.boolean(),
  interactivePermissions: z.boolean(),
  askUserQuestion: z.boolean(),
  deferredTools: z.boolean(),
  settingSources: z.boolean(),
  sessionResume: z.boolean(),
  imageInputs: z.boolean(),
});

const fileAttachmentSchema = z.object({
  type: z.enum(['file', 'image']),
  name: z.string(),
  mimeType: z.string().optional(),
  base64Data: z.string(),
  localPath: z.string().optional(),
  url: z.string().optional(),
});

export interface RemoteProviderDescriptor {
  kind: AgentProviderKind;
  displayName: string;
  capabilities: AgentProviderCapabilities;
  available: boolean;
  version?: string;
  reason?: string;
}

export interface RemoteWorkspaceDescriptor {
  path: string;
  label?: string;
}

export interface RemoteSessionDescriptor {
  provider: AgentProviderKind;
  providerDisplayName?: string;
  sdkSessionId: string;
  cwd: string;
  mtime: number;
  size?: number;
  preview: string;
}

export interface RemoteClientHostDescriptor {
  hostname?: string;
  platform?: string;
  ipAddresses?: string[];
}

export interface RemoteClientUpgradeDescriptor {
  supported: boolean;
  installRoot?: string;
}

export interface RemoteDirectoryEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file' | 'other';
}

export interface ClientHelloMessage {
  type: 'client.hello';
  protocolVersion: number;
  clientId: string;
  name: string;
  note?: string;
  providers: RemoteProviderDescriptor[];
  workspaces: RemoteWorkspaceDescriptor[];
  sessions?: RemoteSessionDescriptor[];
  host?: RemoteClientHostDescriptor;
  upgrade?: RemoteClientUpgradeDescriptor;
  version?: string;
}

export interface ServerHelloMessage {
  type: 'server.hello';
  protocolVersion: number;
  serverId: string;
  heartbeatIntervalMs: number;
}

export interface ServerPingMessage {
  type: 'server.ping';
  timestamp: number;
}

export interface ClientPongMessage {
  type: 'client.pong';
  timestamp: number;
}

export interface TurnStartMessage {
  type: 'turn.start';
  turnId: string;
  sessionId: string;
  provider: AgentProviderKind;
  prompt: string;
  workingDirectory: string;
  sdkSessionId?: string;
  model?: string;
  effort?: EffortLevel;
  settingSources?: AgentSettingSource[];
  appendSystemPrompt?: string;
  attachments?: FileAttachment[];
}

export interface TurnStartedMessage {
  type: 'turn.started';
  turnId: string;
}

export interface TurnEventMessage {
  type: 'turn.event';
  turnId: string;
  event: CanonicalEvent;
}

export interface TurnCompleteMessage {
  type: 'turn.complete';
  turnId: string;
}

export interface TurnErrorMessage {
  type: 'turn.error';
  turnId: string;
  message: string;
}

export type RemoteControlAction = 'interrupt' | 'stop_task' | 'close' | 'steer' | 'send_priority';

export interface ControlMessage {
  type: 'control';
  controlId: string;
  sessionId: string;
  action: RemoteControlAction;
  taskId?: string;
  text?: string;
  priority?: 'now' | 'next' | 'later';
}

export interface ControlResultMessage {
  type: 'control.result';
  controlId: string;
  ok: boolean;
  error?: string;
}

export type ClientCommandAction = 'path.stat' | 'path.list' | 'shell.exec' | 'client.upgrade';

export interface ClientCommandMessage {
  type: 'client.command';
  commandId: string;
  action: ClientCommandAction;
  path?: string;
  cwd?: string;
  command?: string;
  version?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface ClientCommandResultMessage {
  type: 'client.command.result';
  commandId: string;
  ok: boolean;
  path?: string;
  exists?: boolean;
  isDirectory?: boolean;
  entries?: RemoteDirectoryEntry[];
  hasMore?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  signal?: string;
  error?: string;
}

export type RemoteInteractionKind = 'permission' | 'ask_user_question' | 'deferred_tool';

export interface InteractionRequestMessage {
  type: 'interaction.request';
  interactionId: string;
  turnId: string;
  kind: RemoteInteractionKind;
  payload: Record<string, unknown>;
}

export interface InteractionResponseMessage {
  type: 'interaction.response';
  interactionId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface ClientStatusMessage {
  type: 'client.status';
  activeTurns: number;
  sessions?: RemoteSessionDescriptor[];
}

export type ClientToServerMessage =
  | ClientHelloMessage
  | ClientPongMessage
  | TurnStartedMessage
  | TurnEventMessage
  | TurnCompleteMessage
  | TurnErrorMessage
  | InteractionRequestMessage
  | ControlResultMessage
  | ClientCommandResultMessage
  | ClientStatusMessage;

export type ServerToClientMessage =
  | ServerHelloMessage
  | ServerPingMessage
  | TurnStartMessage
  | ControlMessage
  | ClientCommandMessage
  | InteractionResponseMessage;

export type RemoteProtocolMessage = ClientToServerMessage | ServerToClientMessage;

const clientHelloSchema = z.object({
  type: z.literal('client.hello'),
  protocolVersion: z.number().int().positive(),
  clientId: z.string().min(1),
  name: z.string().min(1),
  note: z.string().optional(),
  providers: z.array(
    z.object({
      kind: providerKindSchema,
      displayName: z.string(),
      capabilities: providerCapabilitiesSchema,
      available: z.boolean(),
      version: z.string().optional(),
      reason: z.string().optional(),
    }),
  ),
  workspaces: z.array(z.object({ path: z.string(), label: z.string().optional() })),
  sessions: z
    .array(
      z.object({
        provider: providerKindSchema,
        providerDisplayName: z.string().optional(),
        sdkSessionId: z.string(),
        cwd: z.string(),
        mtime: z.number(),
        size: z.number().optional(),
        preview: z.string(),
      }),
    )
    .optional(),
  host: z
    .object({
      hostname: z.string().optional(),
      platform: z.string().optional(),
      ipAddresses: z.array(z.string()).optional(),
    })
    .optional(),
  upgrade: z
    .object({
      supported: z.boolean(),
      installRoot: z.string().optional(),
    })
    .optional(),
  version: z.string().optional(),
});

const serverHelloSchema = z.object({
  type: z.literal('server.hello'),
  protocolVersion: z.number().int().positive(),
  serverId: z.string(),
  heartbeatIntervalMs: z.number().int().positive(),
});

const turnStartSchema = z.object({
  type: z.literal('turn.start'),
  turnId: z.string(),
  sessionId: z.string(),
  provider: providerKindSchema,
  prompt: z.string(),
  workingDirectory: z.string(),
  sdkSessionId: z.string().optional(),
  model: z.string().optional(),
  effort: canonicalEffortSchema.optional(),
  settingSources: z.array(settingSourceSchema).optional(),
  appendSystemPrompt: z.string().optional(),
  attachments: z.array(fileAttachmentSchema).optional(),
});

export const remoteProtocolMessageSchema = z.discriminatedUnion('type', [
  clientHelloSchema,
  serverHelloSchema,
  z.object({ type: z.literal('server.ping'), timestamp: z.number() }),
  z.object({ type: z.literal('client.pong'), timestamp: z.number() }),
  turnStartSchema,
  z.object({ type: z.literal('turn.started'), turnId: z.string() }),
  z.object({ type: z.literal('turn.event'), turnId: z.string(), event: canonicalEventSchema }),
  z.object({ type: z.literal('turn.complete'), turnId: z.string() }),
  z.object({ type: z.literal('turn.error'), turnId: z.string(), message: z.string() }),
  z.object({
    type: z.literal('control'),
    controlId: z.string(),
    sessionId: z.string(),
    action: z.enum(['interrupt', 'stop_task', 'close', 'steer', 'send_priority']),
    taskId: z.string().optional(),
    text: z.string().optional(),
    priority: z.enum(['now', 'next', 'later']).optional(),
  }),
  z.object({
    type: z.literal('control.result'),
    controlId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal('client.command'),
    commandId: z.string(),
    action: z.enum(['path.stat', 'path.list', 'shell.exec', 'client.upgrade']),
    path: z.string().optional(),
    cwd: z.string().optional(),
    command: z.string().optional(),
    version: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxBufferBytes: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('client.command.result'),
    commandId: z.string(),
    ok: z.boolean(),
    path: z.string().optional(),
    exists: z.boolean().optional(),
    isDirectory: z.boolean().optional(),
    entries: z
      .array(
        z.object({
          name: z.string(),
          path: z.string(),
          kind: z.enum(['directory', 'file', 'other']),
        }),
      )
      .optional(),
    hasMore: z.boolean().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal('interaction.request'),
    interactionId: z.string(),
    turnId: z.string(),
    kind: z.enum(['permission', 'ask_user_question', 'deferred_tool']),
    payload: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('interaction.response'),
    interactionId: z.string(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal('client.status'),
    activeTurns: z.number().int().nonnegative(),
    sessions: z
      .array(
        z.object({
          provider: providerKindSchema,
          providerDisplayName: z.string().optional(),
          sdkSessionId: z.string(),
          cwd: z.string(),
          mtime: z.number(),
          size: z.number().optional(),
          preview: z.string(),
        }),
      )
      .optional(),
  }),
]);

export function parseRemoteProtocolMessage(raw: unknown): RemoteProtocolMessage {
  return remoteProtocolMessageSchema.parse(raw) as RemoteProtocolMessage;
}

export function encodeRemoteProtocolMessage(message: RemoteProtocolMessage): string {
  return JSON.stringify(message);
}
