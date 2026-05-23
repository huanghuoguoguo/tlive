import { CALLBACK_PREFIXES } from '../../../shared/core/callbacks.js';

/** Parse callback data into parts */
function parseCallback(callbackData: string): string[] {
  return callbackData.split(':');
}

/** Generic callback parser that reduces boilerplate */
function parseCallbackFields<T extends Record<string, string | number>>(
  callbackData: string,
  prefix: string,
  minParts: number,
  fieldMap: Record<number, { name: keyof T; transform?: (v: string) => string | number }>,
): T | null {
  if (!callbackData.startsWith(prefix)) return null;
  const parts = parseCallback(callbackData);
  // minParts should cover the maximum index in fieldMap
  const requiredParts = Math.max(
    minParts,
    ...Object.keys(fieldMap)
      .map(Number)
      .map((i) => i + 1),
  );
  if (parts.length < requiredParts) return null;
  const result: Record<string, string | number> = {};
  for (const [idx, field] of Object.entries(fieldMap)) {
    const i = Number(idx);
    const value = parts[i] ?? '';
    result[field.name as string] = field.transform ? field.transform(value) : value;
  }
  return result as T;
}

/** Parse askq_toggle callback: askq_toggle:interactionId:idx:sessionId */
export function parseAskqToggleCallback(
  callbackData: string,
): { interactionId: string; optionIndex: number; sessionId: string } | null {
  return parseCallbackFields(callbackData, CALLBACK_PREFIXES.ASKQ_TOGGLE, 3, {
    1: { name: 'interactionId' },
    2: { name: 'optionIndex', transform: (v) => parseInt(v, 10) },
    3: { name: 'sessionId' },
  });
}

/** Parse askq_submit callback: askq_submit:interactionId:sessionId */
export function parseAskqSubmitCallback(
  callbackData: string,
): { interactionId: string; sessionId: string } | null {
  return parseCallbackFields(callbackData, CALLBACK_PREFIXES.ASKQ_SUBMIT, 2, {
    1: { name: 'interactionId' },
    2: { name: 'sessionId' },
  });
}

/** Parse askq_skip callback: askq_skip:interactionId:sessionId */
export function parseAskqSkipCallback(
  callbackData: string,
): { interactionId: string; sessionId: string } | null {
  return parseCallbackFields(callbackData, CALLBACK_PREFIXES.ASKQ_SKIP, 2, {
    1: { name: 'interactionId' },
    2: { name: 'sessionId' },
  });
}

/** Parse form callback: form:interactionId:{JSON} */
export function parseFormCallback(
  callbackData: string,
): { interactionId: string; formData: Record<string, string> } | null {
  if (!callbackData.startsWith(CALLBACK_PREFIXES.FORM)) return null;
  // Format: form:interactionId:{JSON formData}
  // The JSON part contains all form values including _interaction_id
  const afterPrefix = callbackData.slice(CALLBACK_PREFIXES.FORM.length);
  const firstColon = afterPrefix.indexOf(':');
  if (firstColon < 0) return null;
  const interactionId = afterPrefix.slice(0, firstColon);
  const jsonStr = afterPrefix.slice(firstColon + 1);
  try {
    const formData = JSON.parse(jsonStr) as Record<string, string>;
    return { interactionId, formData };
  } catch {
    return null;
  }
}

/** Parse deferred submit callback: deferred:submit:permId */
export function parseDeferredSubmitCallback(callbackData: string): { permId: string } | null {
  return parseCallbackFields(callbackData, CALLBACK_PREFIXES.DEFERRED_SUBMIT, 2, {
    1: { name: 'permId' },
  });
}

/** Parse deferred skip callback: deferred:skip:permId */
export function parseDeferredSkipCallback(callbackData: string): { permId: string } | null {
  return parseCallbackFields(callbackData, CALLBACK_PREFIXES.DEFERRED_SKIP, 2, {
    1: { name: 'permId' },
  });
}
