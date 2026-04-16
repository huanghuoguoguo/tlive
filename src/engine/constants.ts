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
  DEFERRED: 'deferred:',
  DEFERRED_SUBMIT: 'deferred:submit:',
  DEFERRED_SKIP: 'deferred:skip:',
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

/** Default permission/question timeout (5 minutes) */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

/** Session stale threshold - session considered stale after 2 hours of inactivity */
export const SESSION_STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

/** Command flags */
export const FLAGS = {
  ALL: { long: '--all', short: '-a' },
} as const;

/** Check if args contain a specific flag (long or short form, case-insensitive) */
export function hasFlag(args: string[], flag: { long: string; short?: string }): boolean {
  return args.some(arg => {
    const normalized = arg.toLowerCase();
    return normalized === flag.long || (flag.short !== undefined && normalized === flag.short);
  });
}

/** Get first argument that is not one of the specified flags (case-insensitive) */
export function getNonFlagArg(
  args: string[],
  flags: Array<{ long: string; short?: string }>
): string | undefined {
  return args.find(arg => {
    const normalized = arg.toLowerCase();
    return !flags.some(f => normalized === f.long || (f.short !== undefined && normalized === f.short));
  });
}

/** Lightweight estimate for IM feedback - average seconds per turn */
export const AVERAGE_TURN_SECONDS = 45;
