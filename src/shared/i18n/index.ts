export type { Locale, Translations, TranslationKey } from './types.js';

import type { Locale, TranslationKey } from './types.js';
import { en } from './en.js';
import { zh } from './zh.js';

const dictionaries = { en, zh } as const;

/** Global default locale - can be set at startup */
let globalLocale: Locale = 'zh';

/** Set the global default locale */
export function setGlobalLocale(locale: Locale): void {
  globalLocale = locale;
}

/** Get the current global locale */
export function getGlobalLocale(): Locale {
  return globalLocale;
}

/** Look up a translation by key (uses global locale, or override if provided) */
export function t(key: TranslationKey, localeOverride?: Locale): string {
  const locale = localeOverride ?? globalLocale;
  return dictionaries[locale][key];
}

/** Check if input matches a localized keyword (both zh and en variants) */
export function matchesLocalizedInput(input: string, key: TranslationKey): boolean {
  const normalized = input.toLowerCase().trim();
  const zhValue = zh[key].toLowerCase();
  const enValue = en[key].toLowerCase();
  return normalized === zhValue || normalized === enValue;
}

/** Get all localized variants for a key (for recognition lists) */
export function getLocalizedVariants(key: TranslationKey): string[] {
  return [zh[key], en[key]];
}
