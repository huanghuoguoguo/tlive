/** Callback data prefixes shared by UI builders and callback dispatchers. */
export const CALLBACK_PREFIXES = {
  ACTION: 'action:',
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

export interface ActionCallback {
  name: string;
  args: string[];
}

export function actionCallback(name: string, ...args: Array<string | undefined>): string {
  const encodedArgs = args
    .filter((arg): arg is string => !!arg?.trim())
    .map((arg) => encodeURIComponent(arg.trim()));
  return `${CALLBACK_PREFIXES.ACTION}${encodeURIComponent(name)}${encodedArgs.length ? `:${encodedArgs.join(':')}` : ''}`;
}

export function parseActionCallback(callbackData?: string): ActionCallback | undefined {
  if (!callbackData?.startsWith(CALLBACK_PREFIXES.ACTION)) return undefined;
  const rawParts = callbackData.slice(CALLBACK_PREFIXES.ACTION.length).split(':');
  const name = decodeURIComponent(rawParts[0] ?? '').trim();
  if (!name) return undefined;
  return {
    name,
    args: rawParts.slice(1).map((part) => decodeURIComponent(part)),
  };
}

export function parseCommandCallback(callbackData?: string): string | undefined {
  if (!callbackData?.startsWith(CALLBACK_PREFIXES.CMD)) return undefined;
  return callbackData.slice(CALLBACK_PREFIXES.CMD.length).trim() || undefined;
}
