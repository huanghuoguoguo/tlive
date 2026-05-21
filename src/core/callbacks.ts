/** Callback data prefixes shared by UI builders and callback dispatchers. */
export const CALLBACK_PREFIXES = {
  SUGGEST: 'suggest:',
  ASKQ_TOGGLE: 'askq_toggle:',
  ASKQ_SUBMIT: 'askq_submit:',
  ASKQ_SKIP: 'askq_skip:',
  FORM: 'form:',
  CMD: 'cmd:',
  DEFERRED: 'deferred:',
  DEFERRED_SUBMIT: 'deferred:submit:',
  DEFERRED_SKIP: 'deferred:skip:',
  PERM_ALLOW_SAME: 'perm:allow_same:',
  PERM_ALLOW_ALL_SESSION: 'perm:allow_all_session:',
  PERM_ALLOW: 'perm:allow:',
  PERM_DENY: 'perm:deny:',
} as const;

export function commandCallback(command: string, args?: string): string {
  const suffix = args?.trim();
  return `${CALLBACK_PREFIXES.CMD}${command}${suffix ? ` ${suffix}` : ''}`;
}

export function parseCommandCallback(callbackData?: string): string | undefined {
  if (!callbackData?.startsWith(CALLBACK_PREFIXES.CMD)) return undefined;
  return callbackData.slice(CALLBACK_PREFIXES.CMD.length).trim() || undefined;
}
