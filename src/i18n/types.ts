/** Supported locales */
export type Locale = 'en' | 'zh';

/** Flat translation dictionary — all keys are dot-separated paths */
export interface Translations {
  // --- question ---
  'question.multiSelectHint': string;
  'question.singleSelectHint': string;

  // --- deferredToolInput ---
  'deferred.title': string;
  'deferred.toolLabel': string;
  'deferred.descLabel': string;
  'deferred.inputHint': string;

  // --- home ---
  'home.taskActive': string;
  'home.taskIdle': string;
  'home.workspaceBinding': string;
  'home.activeSessions': string;
  'home.recentSessions': string;
  'home.btnSessions': string;
  'home.btnPermissions': string;
  'home.btnNew': string;
  'home.btnHelp': string;

  // --- permissionStatus ---
  'perm.title': string;
  'perm.mode': string;
  'perm.remembered': string;
  'perm.pendingApproval': string;
  'perm.lastDecision': string;
  'perm.decisionAllow': string;
  'perm.decisionAlwaysAllow': string;
  'perm.decisionDeny': string;
  'perm.decisionCancelled': string;
  'perm.btnTurnOff': string;
  'perm.btnTurnOn': string;
  'perm.btnHome': string;

  // --- taskStart ---
  'taskStart.resetTitle': string;
  'taskStart.title': string;
  'taskStart.directory': string;
  'taskStart.permMode': string;
  'taskStart.permOn': string;
  'taskStart.previousSession': string;
  'taskStart.btnSettings': string;
  'taskStart.btnNew': string;

  // --- sessions ---
  'sessions.footer': string;

  // --- newSession ---
  'newSession.title': string;

  // --- taskSummary ---
  'taskSummary.title': string;
  'taskSummary.changedFiles': string;
  'taskSummary.permissionPrompts': string;
  'taskSummary.statusError': string;
  'taskSummary.statusDone': string;
  'taskSummary.btnHome': string;
  'taskSummary.btnRecent': string;

  // --- progress buttons ---
  'progress.btnSessions': string;
  'progress.btnNew': string;
  'progress.btnHelp': string;
  'progress.btnStop': string;

  // --- versionUpdate ---
  'version.title': string;
  'version.released': string;

  // --- multiSelectToggle ---
  'multiSelect.hint': string;

  // --- text-dispatcher ---
  'dispatcher.multiPermHint': string;

  // --- qqbot progress ---
  'progress.starting': string;
  'progress.executing': string;
  'progress.waitingPermission': string;
  'progress.completed': string;
  'progress.failed': string;
  'progress.taskLabel': string;
  'progress.timeLabel': string;
}

export type TranslationKey = keyof Translations;
