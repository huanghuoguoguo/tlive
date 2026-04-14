import type { Translations } from './types.js';

export const en: Translations = {
  // --- question ---
  'question.multiSelectHint': '💬 Tap options to toggle, then Submit',
  'question.singleSelectHint': '💬 Reply with number to select, or type your answer',

  // --- deferredToolInput ---
  'deferred.title': '⏳ **Input Required**',
  'deferred.toolLabel': 'Tool',
  'deferred.descLabel': 'Description',
  'deferred.inputHint': '💬 Type your input or reply "skip"',

  // --- home ---
  'home.taskActive': 'Task in progress',
  'home.taskIdle': 'No active task',
  'home.workspaceBinding': 'Workspace binding',
  'home.activeSessions': 'Active sessions',
  'home.recentSessions': '**Recent sessions**',
  'home.btnSessions': '🕘 Recent',
  'home.btnPermissions': '🔐 Permissions',
  'home.btnNew': '🆕 New',
  'home.btnHelp': '❓ Help',

  // --- permissionStatus ---
  'perm.title': '🔐 **Permission Status**',
  'perm.mode': 'Mode',
  'perm.remembered': 'Remembered in this session',
  'perm.pendingApproval': 'Pending approval',
  'perm.lastDecision': 'Last decision',
  'perm.decisionAllow': 'Allowed once',
  'perm.decisionAlwaysAllow': 'Always allow in session',
  'perm.decisionDeny': 'Denied',
  'perm.decisionCancelled': 'Cancelled',
  'perm.btnTurnOff': '⚡ Turn Off',
  'perm.btnTurnOn': '🔐 Turn On',
  'perm.btnHome': '🏠 Home',

  // --- taskStart ---
  'taskStart.resetTitle': '🔄 **Session reset, starting new task**',
  'taskStart.title': '🚀 **Starting task**',
  'taskStart.directory': 'Directory',
  'taskStart.permMode': 'Permission mode',
  'taskStart.permOn': 'on',
  'taskStart.previousSession': 'Previous session',
  'taskStart.btnSettings': '⚡ Settings',
  'taskStart.btnNew': '🆕 New',

  // --- sessions ---
  'sessions.footer': '\nUse /session <n> to switch',

  // --- newSession ---
  'newSession.title': '✅ **New Session**',

  // --- taskSummary ---
  'taskSummary.title': '✅ **Task Summary**',
  'taskSummary.changedFiles': 'Changed files',
  'taskSummary.permissionPrompts': 'Permission prompts',
  'taskSummary.statusError': 'Has errors',
  'taskSummary.statusDone': 'Completed',
  'taskSummary.btnHome': '🏠 Home',
  'taskSummary.btnRecent': '🕘 Recent',

  // --- progress buttons ---
  'progress.btnSessions': '🕘 Recent',
  'progress.btnNew': '🆕 New',
  'progress.btnHelp': '❓ Help',
  'progress.btnStop': '⏹ Stop',

  // --- versionUpdate ---
  'version.title': '🔄 **Update Available**',
  'version.released': 'Released',

  // --- multiSelectToggle ---
  'multiSelect.hint': '💬 Tap options to toggle, then Submit',

  // --- text-dispatcher ---
  'dispatcher.multiPermHint': '⚠️ Multiple permissions pending — reply to the specific permission message',

  // --- qqbot progress ---
  'progress.starting': '⏳ Starting',
  'progress.executing': '⏳ Running',
  'progress.waitingPermission': '🔐 Waiting for permission',
  'progress.completed': '✅ Completed',
  'progress.failed': '⚠️ Failed',
  'progress.taskLabel': 'Task',
  'progress.timeLabel': 'Time',
};
