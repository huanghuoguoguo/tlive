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
  'perm.decisionAllowSameCommand': string;
  'perm.decisionAllowSessionAll': string;
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
  'perm.labelSession': string;
  'perm.labelSessionMemory': string;
  'perm.labelTools': string;
  'perm.labelBashPrefixes': string;
  'perm.labelNoPending': string;
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
  'progress.titleFailed': string;
  'progress.titleWaitingPerm': string;
  'progress.titleContinue': string;
  'progress.titleStarting': string;
  'progress.titleRunning': string;
  'progress.apiRetry': string;
  'progress.compacting': string;
  'progress.andMore': string;

  // --- versionUpdate ---
  'version.title': string;
  'version.current': string;
  'version.latest': string;
  'version.released': string;
  'version.notes': string;
  'version.upgradeAction': string;

  // --- multiSelectToggle ---
  'multiSelect.hint': string;

  // --- text-dispatcher ---
  'dispatcher.multiPermHint': string;

  // --- progress ---
  'progress.starting': string;
  'progress.executing': string;
  'progress.waitingPermission': string;
  'progress.completed': string;
  'progress.failed': string;
  'progress.taskLabel': string;
  'progress.timeLabel': string;

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
  'format.titlePermissionStatus': string;
  'format.titleQuestion': string;
  'format.titleDeferredInput': string;
  'format.titleTaskReset': string;
  'format.titleTaskStart': string;
  'format.titleTaskEnd': string;
  'format.titleTaskSummary': string;
  'format.titleDiagnose': string;
  'format.statusRunning': string;
  'format.statusDisconnected': string;
  'format.statusActive': string;
  'format.statusIdle': string;
  'format.statusTotal': string;
  'format.queueEmpty': string;
  'format.flushErrorTitle': string;
  'format.flushErrorHint': string;

  // --- diagnose ---
  'diagnose.labelSessions': string;
  'diagnose.labelQueuedMessages': string;
  'diagnose.labelProcessingChats': string;
  'diagnose.labelBubbleMappings': string;
  'diagnose.labelPersistedBindings': string;
  'diagnose.labelPersistedTopicSessions': string;
  'diagnose.labelCurrentChat': string;
  'diagnose.labelQueueUtilization': string;
  'diagnose.labelSaturatedSessions': string;
  'diagnose.labelBusiestSession': string;
  'diagnose.labelQueueDetail': string;

  // --- adapter ---
  'adapter.submitted': string;
  'adapter.processing': string;
  'adapter.acceptedImage': string;
  'adapter.processingImage': string;

  // --- input recognition ---
  'input.skip': string;
  'input.allow': string;
  'input.allowAlways': string;
  'input.deny': string;
  'input.skipped': string;
  'input.submitted': string;
  'input.allowKeywords': string;
  'input.denyKeywords': string;

  // --- recent projects ---
  'recentProjects.hint': string;

  // --- error notification ---
  'error.title': string;
  'error.requestId': string;

  // --- formatter ---
  'formatter.runInfo': string;
  'formatter.sessionNone': string;
  'formatter.sessionRunningLabel': string;
  'formatter.sessionIdleLabel': string;
  'formatter.interactiveMode': string;
  'formatter.turnBasedMode': string;
  'formatter.toolApprovalRequired': string;
  'formatter.toolCallsAutoAllowed': string;
  'formatter.topicPermissionStatus': string;
  'formatter.codexPermissionNote': string;
  'formatter.codexSlashNote': string;
  'formatter.otherSlashPassThrough': string;
  'formatter.currentSession': string;
  'formatter.capabilities': string;
  'formatter.basicChat': string;
  'formatter.imageInput': string;
  'formatter.instantSteer': string;
  'formatter.queueCapability': string;
  'formatter.sessionActions': string;
  'formatter.directory': string;

  // --- format-home ---
  'home.newSessionDefaultWorkspace': string;
  'home.statusCanContinue': string;
  'home.btnBackToTopic': string;
  'home.btnResumeToTopic': string;
  'home.panelRecentTopics': string;
  'home.panelRecentLocalSessions': string;
  'home.panelDiagnostics': string;
  'home.btnViewRecentSessions': string;
  'home.btnViewLocalHistory': string;
  'home.btnBridgeStatus': string;
  'home.btnInternalDiagnose': string;
  'home.commandPlaceholder': string;
  'home.btnExecute': string;

  // --- message-loop ---
  'msgLoop.replyTargetMissing': string;
  'msgLoop.sendFailed': string;
  'msgLoop.busyUnsupported': string;
  'msgLoop.noActiveSession': string;
  'msgLoop.queueFull': string;
  'msgLoop.processFailed': string;
  'msgLoop.inserted': string;
  'msgLoop.queued': string;

  // --- presenter ---
  'presenter.currentDir': string;
  'presenter.workspaceBinding': string;
  'presenter.dirHistory': string;
  'presenter.totalCount': string;
  'presenter.cdHint': string;
  'presenter.settingsUnavailable': string;
  'presenter.stopInterrupted': string;
  'presenter.stopNoExecution': string;

  // --- cost-tracker ---
  'cost.input': string;
  'cost.output': string;
  'cost.reasoning': string;
  'cost.cached': string;

  // --- format-session-list ---
  'sessionList.stateRunning': string;
  'sessionList.stateCurrent': string;
  'sessionList.stateCanContinue': string;
  'sessionList.roleAssistant': string;
  'sessionList.roleUser': string;
  'sessionList.recentMessages': string;
  'sessionList.topic': string;
  'sessionList.executionNode': string;
  'sessionList.workspace': string;
  'sessionList.preview': string;

  // --- home-command ---
  'homeCmd.description': string;
  'homeCmd.helpDesc': string;
  'homeCmd.tliveDescription': string;
  'homeCmd.tliveHelpDesc': string;
  'homeCmd.recentTopicsTitle': string;
  'homeCmd.recentTopicsEmpty': string;
  'homeCmd.btnBackToTopic': string;
  'homeCmd.recentLocalTitle': string;
  'homeCmd.recentLocalEmpty': string;
  'homeCmd.recentSessionsTitle': string;
  'homeCmd.recentSessionsEmpty': string;
  'homeCmd.recentNodeTitle': string;
  'homeCmd.recentNodeEmpty': string;
  'homeCmd.btnResumeToTopic': string;

  // --- topic-resume ---
  'topicResume.sessionPreview': string;
  'topicResume.connected': string;
  'topicResume.sessionNotFound': string;
  'topicResume.resumed': string;
  'topicResume.anchorMissing': string;
  'topicResume.fromWorkbench': string;
  'topicResume.createFailed': string;

  // --- progress-builder ---
  'progress.engineLabel': string;
  'progress.thinkingLabel': string;
  'progress.continueExec': string;

  // --- markdown ---
  'markdown.tableChunk': string;

  // --- upgrade command ---
  'cmd.upgrade.description': string;
  'cmd.upgrade.helpDesc': string;
  'cmd.upgrade.notesHint': string;
  'cmd.upgrade.checkFailed': string;
  'cmd.upgrade.alreadyLatest': string;
  'cmd.upgrade.alreadyRunning': string;
  'cmd.upgrade.gitCheckout': string;
  'cmd.upgrade.starting': string;
  'cmd.upgrade.failed': string;

  // --- new command ---
  'cmd.new.description': string;
  'cmd.new.helpDesc': string;
  'cmd.new.unsupportedType': string;
  'cmd.new.providerUnavailable': string;
  'cmd.new.reason': string;
  'cmd.new.topicTitle': string;
  'cmd.new.topicIntro': string;

  // --- cd command ---
  'cmd.cd.description': string;
  'cmd.cd.helpDesc': string;
  'cmd.cd.noHistory': string;
  'cmd.cd.switchedBack': string;
  'cmd.cd.switchedRepo': string;

  // --- stop command ---
  'cmd.stop.description': string;
  'cmd.stop.helpDesc': string;
  'cmd.stop.workbenchHint': string;

  // --- perm command ---
  'cmd.perm.description': string;
  'cmd.perm.helpDesc': string;

  // --- deferred-tool ---
  'deferred.hint': string;
  'deferred.btnLabel': string;

  // --- policy ---
  'policy.imageAccepted': string;
  'policy.imageRejected': string;
  'policy.imageRejectedReason': string;

  // --- session-format ---
  'format.minAgo': string;
  'format.hourAgo': string;
  'format.dayAgo': string;

  // --- main ---
  'main.upgradeSuccess': string;
  'main.upgradeFailed': string;

  // --- buttons ---
  'btn.stopExec': string;
  'btn.newSession': string;
  'btn.newProviderSession': string;

  // --- surface-policy ---
  'surface.steerUnsupported': string;
  'surface.queueUnsupported': string;
  'surface.tliveRejection': string;
  'surface.homeRejection': string;
  'surface.continueRejection': string;

  // --- topic-conversation ---
  'topic.agentSession': string;
  'topic.started': string;

  // --- home-model ---
  'homeModel.bound': string;
  'homeModel.unbound': string;
  'homeModel.agentSession': string;

  // --- command-router ---
  'router.unknownCommand': string;
  'router.workbenchCommandHint': string;

  // --- sdk-perm-tracker ---
  'sdkPerm.tracking': string;
  'sdkPerm.notTracking': string;

  // --- form-callbacks ---
  'formCmd.executed': string;
  'formCmd.enterCommand': string;

  // --- query ---
  'query.replyMissing': string;

  // --- query-recovery ---
  'queryRecovery.sessionMissing': string;
  'queryRecovery.staleSessionFallback': string;

  // --- continue command ---
  'cmd.continue.description': string;
  'cmd.continue.usage': string;

  // --- help-categories ---
  'helpCat.session': string;
  'helpCat.status': string;
  'helpCat.system': string;
  'helpCat.agent': string;
  'helpCat.other': string;
  'helpCat.sessionDesc': string;
  'helpCat.statusDesc': string;
  'helpCat.systemDesc': string;
  'helpCat.agentDesc': string;

  // --- help format ---
  'help.exampleLabel': string;

  // --- other commands ---
  'cmd.status.description': string;
  'cmd.settings.description': string;
  'cmd.restart.description': string;
  'cmd.pwd.description': string;
  'cmd.help.description': string;
  'cmd.diagnose.description': string;
  'cmd.bash.description': string;

  // --- feishu adapter ---
  'feishu.topicProcessing': string;
  'feishu.topicContinue': string;

  // --- deferred-tool handler ---
  'deferredTool.planModePrompt': string;
  'deferredTool.planModePlaceholder': string;
  'deferredTool.worktreePrompt': string;
  'deferredTool.worktreePlaceholder': string;
  'deferredTool.toolInputPrompt': string;
  'deferredTool.toolInputPlaceholder': string;

  // --- form validation ---
  'form.invalidSelection': string;
  'form.submitWithoutAnswer': string;
}

export type TranslationKey = keyof Translations;
