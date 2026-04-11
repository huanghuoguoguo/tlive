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
  FORM: 'form:',
  CMD: 'cmd:',
  HOOK: 'hook:',
  PERM_ALLOW_EDITS: 'perm:allow_edits:',
  PERM_ALLOW_TOOL: 'perm:allow_tool:',
  PERM_ALLOW_BASH: 'perm:allow_bash:',
  PERM_ALLOW: 'perm:allow:',
  PERM_ALLOW_SESSION: 'perm:allow_session:',
  PERM_DENY: 'perm:deny:',
} as const;

/** Platform message limits */
export const PLATFORM_LIMITS: Record<ChannelType, number> = {
  [CHANNEL_TYPES.TELEGRAM]: 4096,
  [CHANNEL_TYPES.FEISHU]: 30000,
  [CHANNEL_TYPES.QQBOT]: 4096,
};

/** Reaction emojis per platform */
export const PLATFORM_REACTIONS: Record<ChannelType, { processing: string; done: string; error: string; stalled: string; permission: string }> = {
  [CHANNEL_TYPES.TELEGRAM]: { processing: '\u{1F914}', done: '\u{1F44D}', error: '\u{1F631}', stalled: '\u{23F3}', permission: '\u{1F510}' },
  [CHANNEL_TYPES.FEISHU]: { processing: 'Typing', done: 'OK', error: 'FACEPALM', stalled: 'OneSecond', permission: 'Pin' },
  [CHANNEL_TYPES.QQBOT]: { processing: '\u{1F914}', done: '\u{1F44D}', error: '\u{1F631}', stalled: '\u{23F3}', permission: '\u{1F510}' },
};

/** Text permission acknowledgement reactions per platform */
export const PLATFORM_PERMISSION_DECISION_REACTIONS: Record<ChannelType, { allow: string; allow_always: string; deny: string }> = {
  [CHANNEL_TYPES.TELEGRAM]: { allow: '\u{1F44D}', allow_always: '\u{1F44C}', deny: '\u{1F44E}' },
  [CHANNEL_TYPES.FEISHU]: { allow: 'OK', allow_always: 'DONE', deny: 'No' },
  [CHANNEL_TYPES.QQBOT]: { allow: '\u{1F44D}', allow_always: '\u{1F44C}', deny: '\u{1F44E}' },
};

/** Default permission/question timeout (5 minutes) */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

/** Session stale threshold - session considered stale after 2 hours of inactivity */
export const SESSION_STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;
