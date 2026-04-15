export type { Locale, Translations, TranslationKey } from './types.js';

import type { Locale, TranslationKey } from './types.js';
import { en } from './en.js';
import { zh } from './zh.js';

const dictionaries = { en, zh } as const;

/** Look up a translation by locale and key */
export function t(locale: Locale, key: TranslationKey): string {
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