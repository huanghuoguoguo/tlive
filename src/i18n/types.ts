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
  'deferred.btnSubmit': string;
  'deferred.btnSkip': string;

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
  'home.statusExecuting': string;
  'home.statusActive': string;
  'home.statusIdle': string;
  'home.labelNone': string;
  'home.labelSdkSession': string;
  'home.labelSdkUnbound': string;
  'home.labelQueue': string;
  'home.labelQueuePending': string;
  'home.labelCurrentSession': string;
  'home.labelDirectory': string;
  'home.labelPermission': string;
  'home.labelStatus': string;
  'home.labelHistory': string;
  'home.labelGlobal': string;
  'home.labelRecentChat': string;
  'home.labelSize': string;
  'home.labelActiveIn': string;
  'home.labelSwitch': string;

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
  'perm.labelMode': string;
  'perm.labelModeOn': string;
  'perm.labelModeOff': string;
  'perm.labelResult': string;
  'perm.labelTool': string;
  'perm.labelInput': string;
  'perm.labelExpiresIn': string;
  'perm.labelSession': string;
  'perm.labelSessionMemory': string;
  'perm.labelTools': string;
  'perm.labelBashPrefixes': string;
  'perm.labelNoPending': string;
  'perm.hintReply': string;
  'perm.labelViewInTerminal': string;
  'perm.labelQuestion': string;
  'perm.labelOptions': string;
  'perm.labelDescription': string;
  'perm.hintClickToggle': string;
  'perm.hintClickOrText': string;
  'perm.placeholderSelect': string;
  'perm.placeholderText': string;
  'perm.placeholderTextInput': string;
  'perm.labelToolRequest': string;
  'perm.labelSessionInfo': string;
  'perm.hintInputSubmit': string;
  'perm.placeholderInput': string;
  'perm.btnSubmit': string;
  'perm.btnSubmitText': string;
  'perm.btnSkip': string;
  'perm.hintMultiSelect': string;

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
  'sessions.title': string;
  'sessions.btnList': string;
  'sessions.btnRecent': string;
  'sessions.btnAll': string;
  'sessions.subtitleAll': string;
  'sessions.subtitleRecent': string;
  'sessions.currentMarker': string;
  'sessions.switchTo': string;
  'sessions.labelDirectory': string;
  'sessions.labelTime': string;
  'sessions.labelSize': string;
  'sessions.labelPreview': string;
  'sessions.inputPlaceholder': string;
  'sessions.btnConfirmSwitch': string;
  'sessions.footer': string;

  // --- newSession ---
  'newSession.title': string;
  'newSession.feedbackText': string;

  // --- taskSummary ---
  'taskSummary.title': string;
  'taskSummary.changedFiles': string;
  'taskSummary.permissionPrompts': string;
  'taskSummary.statusError': string;
  'taskSummary.statusDone': string;
  'taskSummary.btnHome': string;
  'taskSummary.btnRecent': string;
  'taskSummary.labelResult': string;

  // --- progress buttons ---
  'progress.btnSessions': string;
  'progress.btnNew': string;
  'progress.btnHelp': string;
  'progress.btnStop': string;
  'progress.phaseThinking': string;
  'progress.phaseCompleted': string;
  'progress.phaseFailed': string;
  'progress.phaseRunning': string;
  'progress.labelThinkingProcess': string;
  'progress.labelToolCalls': string;
  'progress.labelToolSummary': string;
  'progress.labelWorkProgress': string;
  'progress.labelCurrentWait': string;
  'progress.labelPendingApprovals': string;
  'progress.labelElapsedTime': string;
  'progress.labelRecentAction': string;
  'progress.labelStepsCompleted': string;
  'progress.titleCompleted': string;
  'progress.titleStopped': string;
  'progress.titleWaitingPerm': string;
  'progress.titleContinue': string;
  'progress.titleStarting': string;
  'progress.titleRunning': string;
  'progress.apiRetry': string;
  'progress.compacting': string;
  'progress.andMore': string;

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

  // --- queue ---
  'queue.emptyMessage': string;
  'queue.noActiveSession': string;
  'queue.cleared': string;
  'queue.depthInvalid': string;
  'queue.depthSet': string;

  // --- format ---
  'format.justNow': string;
  'format.continueTask': string;
  'format.taskCompleted': string;
  'format.labelStatus': string;
  'format.labelChannel': string;
  'format.labelSession': string;
  'format.labelMemory': string;
  'format.labelUptime': string;
  'format.labelVersion': string;
  'format.labelDirectory': string;
  'format.labelResultSummary': string;
  'format.labelCurrentConfig': string;
  'format.labelPreviousSession': string;
  'format.labelResult': string;
  'format.labelChangedFiles': string;
  'format.labelPermissionRequests': string;
  'format.seconds': string;
  'format.minutes': string;
  'format.hours': string;
  'format.days': string;
  'format.activeAgo': string;
  'format.taskStartHint': string;
  'format.titleStatus': string;
  'format.titleHome': string;
  'format.titlePermission': string;
  'format.titlePermissionStatus': string;
  'format.titleQuestion': string;
  'format.titleDeferredInput': string;
  'format.titleTaskReset': string;
  'format.titleTaskStart': string;
  'format.titleTaskEnd': string;
  'format.titleTaskSummary': string;
  'format.statusRunning': string;
  'format.statusDisconnected': string;
  'format.statusActive': string;
  'format.statusIdle': string;
  'format.statusTotal': string;
  'format.queueEmpty': string;
  'format.flushErrorTitle': string;
  'format.flushErrorHint': string;

  // --- adapter ---
  'adapter.submitted': string;
  'adapter.processing': string;

  // --- input recognition ---
  'input.skip': string;
  'input.allow': string;
  'input.allowAlways': string;
  'input.deny': string;
  'input.skipped': string;
  'input.submitted': string;
  'input.hookDenied': string;
  'input.hookAlwaysAllowed': string;
  'input.hookAllowed': string;
  'input.hookFailed': string;

  // --- push notification ---
  'push.title': string;
  'push.workdir': string;
  'push.project': string;
  'push.session': string;
  'push.preview': string;
  'push.continueHint': string;
  'push.fallbackHint': string;

  // --- recent projects ---
  'recentProjects.hint': string;

  // --- error notification ---
  'error.title': string;
  'error.requestId': string;

  // --- doctor command ---
  'doctor.title': string;
  'doctor.os': string;
  'doctor.node': string;
  'doctor.tlive': string;
  'doctor.uptime': string;
  'doctor.config': string;
  'doctor.configFound': string;
  'doctor.configMissing': string;
  'doctor.claudeCli': string;
  'doctor.notFound': string;
  'doctor.channels': string;
  'doctor.connected': string;
  'doctor.disconnected': string;
}

export type TranslationKey = keyof Translations;