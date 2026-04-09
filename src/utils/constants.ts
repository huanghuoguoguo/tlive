/** Channel type constants - use these instead of raw strings */
export const CHANNEL_TYPES = {
  TELEGRAM: 'telegram',
  FEISHU: 'feishu',
  QQBOT: 'qqbot',
} as const;

export type ChannelType = typeof CHANNEL_TYPES[keyof typeof CHANNEL_TYPES];

/** Callback data prefixes - centralized for consistent parsing */
export const CALLBACK_PREFIXES = {
  SUGGEST: 'suggest:',
  ASKQ: 'askq:',
  ASKQ_TOGGLE: 'askq_toggle:',
  ASKQ_SUBMIT: 'askq_submit:',
  ASKQ_SKIP: 'askq_skip:',
  ASKQ_SUBMIT_SDK: 'askq_submit_sdk:',
  CMD: 'cmd:',
  HOOK: 'hook:',
  PERM_ALLOW_EDITS: 'perm:allow_edits:',
  PERM_ALLOW_TOOL: 'perm:allow_tool:',
  PERM_ALLOW_BASH: 'perm:allow_bash:',
  PERM_ALLOW: 'perm:allow:',
  PERM_DENY: 'perm:deny:',
} as const;

/** Platform message limits */
export const PLATFORM_LIMITS: Record<ChannelType, number> = {
  [CHANNEL_TYPES.TELEGRAM]: 4096,
  [CHANNEL_TYPES.FEISHU]: 30000,
  [CHANNEL_TYPES.QQBOT]: 4096,
};

/** Reaction emojis per platform */
export const PLATFORM_REACTIONS: Record<ChannelType, { processing: string; done: string; error: string }> = {
  [CHANNEL_TYPES.TELEGRAM]: { processing: '\u{1F914}', done: '\u{1F44D}', error: '\u{1F631}' },
  [CHANNEL_TYPES.FEISHU]: { processing: 'Typing', done: 'OK', error: 'FACEPALM' },
  [CHANNEL_TYPES.QQBOT]: { processing: '\u{1F914}', done: '\u{1F44D}', error: '\u{1F631}' },
};