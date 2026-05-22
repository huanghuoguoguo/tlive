import type { Button } from '../ui/types.js';
import type { QuickButtonName } from '../ui/buttons.js';
import type { FormattableMessage } from './message-types.js';
import type { Locale } from '../i18n/index.js';

export interface MessageFormatterOptions {
  doneButtons?: readonly QuickButtonName[];
}

export interface MessageFormatter<TRendered extends { chatId: string }> {
  getLocale(): Locale;
  format(msg: FormattableMessage): TRendered;
  formatContent(chatId: string, content: string, buttons?: Button[]): TRendered;
}
