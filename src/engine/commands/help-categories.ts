import type { HelpCategoryInfo } from '../../formatting/message-types.js';

export type HelpCategoryId = 'session' | 'status' | 'system' | 'other';

export const HELP_CATEGORIES: Record<HelpCategoryId, HelpCategoryInfo> = {
  session: {
    id: 'session',
    title: 'helpCat.session',
    icon: '📁',
    order: 10,
    expandedByDefault: true,
  },
  status: {
    id: 'status',
    title: 'helpCat.status',
    icon: '📡',
    order: 20,
  },
  system: {
    id: 'system',
    title: 'helpCat.system',
    icon: '🛠️',
    order: 30,
  },
  other: {
    id: 'other',
    title: 'helpCat.other',
    icon: '📦',
    order: 90,
  },
};

export function getHelpCategoryInfo(category: HelpCategoryId): HelpCategoryInfo {
  return HELP_CATEGORIES[category];
}
