export { BaseChannelAdapter } from './base.js';
export {
  conversationContextFromInbound,
  conversationScopeId,
  conversationSurfaceFor,
  type ConversationContext,
  type ConversationSurface,
} from './conversation-context.js';
export type {
  ChannelPolicy,
  FormatPolicy,
  PermissionDecision,
  ProgressPhase,
  ProgressPolicy,
  ProgressTraceStats,
  ReactionPolicy,
} from './policy.js';
export type {
  ChannelType,
  InboundMessage,
  RenderedMessage,
  SendResult,
  FileAttachment,
  MediaAttachment,
  StreamingCardSession,
} from './types.js';
export type { Button } from '../ui/types.js';

export {
  FeishuAdapter,
  type FeishuConfig,
} from './feishu/adapter.js';
export {
  FeishuFormatter,
  FEISHU_POLICY,
  markdownToFeishu,
  downgradeHeadings,
  buildFeishuCard,
  buildFeishuButtonElements,
  FeishuStreamingSession,
} from './feishu/index.js';
export type { FeishuRenderedMessage } from './feishu/types.js';
