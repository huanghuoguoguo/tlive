import { CALLBACK_PREFIXES } from './constants.js';

/** Parse callback data into parts */
export function parseCallback(callbackData: string): string[] {
  return callbackData.split(':');
}

/** Check if callback matches a prefix and extract remaining parts */
export function matchCallback(callbackData: string, prefix: keyof typeof CALLBACK_PREFIXES): string[] | null {
  const fullPrefix = CALLBACK_PREFIXES[prefix];
  if (!callbackData.startsWith(fullPrefix)) return null;
  return callbackData.slice(fullPrefix.length).split(':');
}

/** Parse hook callback: hook:allow:ID:sessionId or hook:deny:ID:sessionId */
export function parseHookCallback(callbackData: string): { decision: string; hookId: string; sessionId: string } | null {
  if (!callbackData.startsWith(CALLBACK_PREFIXES.HOOK)) return null;
  const parts = parseCallback(callbackData);
  if (parts.length < 3) return null;
  return {
    decision: parts[1], // allow, allow_always, or deny
    hookId: parts[2],
    sessionId: parts[3] ?? '',
  };
}

/** Parse askq callback: askq:hookId:optionIndex:sessionId */
export function parseAskqCallback(callbackData: string): { hookId: string; optionIndex: number; sessionId: string } | null {
  if (!callbackData.startsWith(CALLBACK_PREFIXES.ASKQ)) return null;
  if (callbackData.startsWith(CALLBACK_PREFIXES.ASKQ_TOGGLE) ||
      callbackData.startsWith(CALLBACK_PREFIXES.ASKQ_SUBMIT) ||
      callbackData.startsWith(CALLBACK_PREFIXES.ASKQ_SKIP) ||
      callbackData.startsWith(CALLBACK_PREFIXES.ASKQ_SUBMIT_SDK)) {
    return null; // Different callback types
  }
  const parts = parseCallback(callbackData);
  if (parts.length < 3) return null;
  return {
    hookId: parts[1],
    optionIndex: parseInt(parts[2], 10),
    sessionId: parts[3] ?? '',
  };
}

/** Parse askq_toggle callback: askq_toggle:hookId:idx:sessionId */
export function parseAskqToggleCallback(callbackData: string): { hookId: string; optionIndex: number; sessionId: string } | null {
  if (!callbackData.startsWith(CALLBACK_PREFIXES.ASKQ_TOGGLE)) return null;
  const parts = parseCallback(callbackData);
  if (parts.length < 3) return null;
  return {
    hookId: parts[1],
    optionIndex: parseInt(parts[2], 10),
    sessionId: parts[3] ?? '',
  };
}

/** Parse askq_submit callback: askq_submit:hookId:sessionId */
export function parseAskqSubmitCallback(callbackData: string): { hookId: string; sessionId: string } | null {
  if (!callbackData.startsWith(CALLBACK_PREFIXES.ASKQ_SUBMIT)) return null;
  const parts = parseCallback(callbackData);
  if (parts.length < 2) return null;
  return {
    hookId: parts[1],
    sessionId: parts[2] ?? '',
  };
}

/** Parse askq_skip callback: askq_skip:hookId:sessionId */
export function parseAskqSkipCallback(callbackData: string): { hookId: string; sessionId: string } | null {
  if (!callbackData.startsWith(CALLBACK_PREFIXES.ASKQ_SKIP)) return null;
  const parts = parseCallback(callbackData);
  if (parts.length < 2) return null;
  return {
    hookId: parts[1],
    sessionId: parts[2] ?? '',
  };
}