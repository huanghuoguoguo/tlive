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
  route?: ActionCallbackRoute;
}

export interface ActionCallbackRoute {
  scopeId?: string;
  threadId?: string;
  replyTargetMessageId?: string;
  replyInThread?: boolean;
}

const ACTION_ROUTE_ARG_PREFIX = '$route=';

export function actionCallback(name: string, ...args: Array<string | undefined>): string {
  const encodedArgs = args
    .filter((arg): arg is string => !!arg?.trim())
    .map((arg) => encodeURIComponent(arg.trim()));
  return `${CALLBACK_PREFIXES.ACTION}${encodeURIComponent(name)}${encodedArgs.length ? `:${encodedArgs.join(':')}` : ''}`;
}

export function routedActionCallback(
  name: string,
  route: ActionCallbackRoute | undefined,
  ...args: Array<string | undefined>
): string {
  const routeArg = route ? `${ACTION_ROUTE_ARG_PREFIX}${JSON.stringify(route)}` : undefined;
  return actionCallback(name, ...args, routeArg);
}

export function parseActionCallback(callbackData?: string): ActionCallback | undefined {
  if (!callbackData?.startsWith(CALLBACK_PREFIXES.ACTION)) return undefined;
  const rawParts = callbackData.slice(CALLBACK_PREFIXES.ACTION.length).split(':');
  const name = decodeURIComponent(rawParts[0] ?? '').trim();
  if (!name) return undefined;
  const args: string[] = [];
  let route: ActionCallbackRoute | undefined;

  for (const rawArg of rawParts.slice(1)) {
    const arg = decodeURIComponent(rawArg);
    if (arg.startsWith(ACTION_ROUTE_ARG_PREFIX)) {
      route = parseActionRoute(arg.slice(ACTION_ROUTE_ARG_PREFIX.length));
      continue;
    }
    args.push(arg);
  }

  const action: ActionCallback = {
    name,
    args,
  };
  if (route) action.route = route;
  return action;
}

export function parseCommandCallback(callbackData?: string): string | undefined {
  if (!callbackData?.startsWith(CALLBACK_PREFIXES.CMD)) return undefined;
  return callbackData.slice(CALLBACK_PREFIXES.CMD.length).trim() || undefined;
}

function parseActionRoute(raw: string): ActionCallbackRoute | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<ActionCallbackRoute>;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const route: ActionCallbackRoute = {};
    if (typeof parsed.scopeId === 'string') route.scopeId = parsed.scopeId;
    if (typeof parsed.threadId === 'string') route.threadId = parsed.threadId;
    if (typeof parsed.replyTargetMessageId === 'string') {
      route.replyTargetMessageId = parsed.replyTargetMessageId;
    }
    if (typeof parsed.replyInThread === 'boolean') route.replyInThread = parsed.replyInThread;
    return Object.keys(route).length > 0 ? route : undefined;
  } catch {
    return undefined;
  }
}
