export { BaseChannelAdapter } from './base.js';
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
