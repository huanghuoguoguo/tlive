export type { Locale, Translations, TranslationKey } from './types.js';

import type { Locale, TranslationKey } from './types.js';
import { en } from './en.js';
import { zh } from './zh.js';

const dictionaries = { en, zh } as const;

/** Look up a translation by locale and key */
export function t(locale: Locale, key: TranslationKey): string {
  return dictionaries[locale][key];
}
