// Shared formatting utilities
export { formatPermissionCard } from './permission.js';
export { formatNotification } from './notification.js';
export { escapeHtml } from './escape.js';
export { MessageFormatter } from './message-formatter.js';
// Platform formatters — canonical implementations live in platforms/*
export { TelegramFormatter } from '../platforms/telegram/formatter.js';
export { FeishuFormatter } from '../platforms/feishu/formatter.js';
export { QQBotFormatter } from '../platforms/qqbot/formatter.js';
export type { PermissionCardData, NotificationData, FeishuCardElement } from './types.js';
export type { FormattableMessage, StatusData, PermissionData, QuestionData, HomeData, SessionsData, ProgressData } from './message-types.js';
