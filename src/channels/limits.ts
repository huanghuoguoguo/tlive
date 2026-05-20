import type { ChannelType } from './types.js';

/** Platform message limits. */
export const PLATFORM_LIMITS: Record<ChannelType, number> = {
  feishu: 30000,
};
