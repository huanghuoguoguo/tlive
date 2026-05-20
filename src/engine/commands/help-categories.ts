import type { HelpCategoryInfo } from '../../formatting/message-types.js';

export type HelpCategoryId = 'session' | 'status' | 'system' | 'other';

export const HELP_CATEGORIES: Record<HelpCategoryId, HelpCategoryInfo> = {
  session: {
    id: 'session',
    title: '会话管理',
    icon: '📁',
    order: 10,
    expandedByDefault: true,
  },
  status: {
    id: 'status',
    title: '状态查看',
    icon: '📡',
    order: 20,
  },
  system: {
    id: 'system',
    title: '系统控制',
    icon: '🛠️',
    order: 30,
  },
  other: {
    id: 'other',
    title: '其他',
    icon: '📦',
    order: 90,
  },
};

export function getHelpCategoryInfo(category: HelpCategoryId): HelpCategoryInfo {
  return HELP_CATEGORIES[category];
}
