// Shared formatting utilities
export { formatPermissionCard } from './permission.js';
export { formatNotification } from './notification.js';
export { escapeHtml } from './escape.js';
export { MessageFormatter } from './message-formatter.js';
// Platform formatters are now in platforms/* — these are legacy re-exports
export { TelegramFormatter } from './telegram-formatter.js';
export { FeishuFormatter } from './feishu-formatter.js';
export { QQBotFormatter } from './qqbot-formatter.js';
export type { PermissionCardData, NotificationData, FeishuCardElement } from './types.js';
export type { FormattableMessage, StatusData, PermissionData, QuestionData, HomeData, SessionsData, ProgressData } from './message-types.js';