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
  'deferred.btnSubmit': '✅ Submit',
  'deferred.btnSkip': '⏭ Skip',

  // --- home ---
  'home.taskActive': 'Task in progress',
  'home.taskIdle': 'No active task',
  'home.workspaceBinding': 'Workspace binding',
  'home.activeSessions': 'Active sessions',
  'home.recentSessions': '**Recent sessions**',
  'home.btnPermissions': '🔐 Permissions',
  'home.btnNew': '🆕 New',
  'home.btnHelp': '❓ Help',
  'home.statusExecuting': 'Running',
  'home.statusActive': 'Active',
  'home.statusIdle': 'Idle',
  'home.labelNone': 'None',
  'home.labelSdkSession': 'SDK Session',
  'home.labelSdkUnbound': 'Unbound',
  'home.labelQueue': 'Queue',
  'home.labelQueuePending': 'pending',
  'home.labelCurrentSession': 'Current session',
  'home.labelDirectory': 'Directory',
  'home.labelPermission': 'Permission',
  'home.labelStatus': 'Status',
  'home.labelHistory': 'History',
  'home.labelGlobal': 'Global',
  'home.labelRecentChat': 'Recent chat',
  'home.labelSize': 'Size',
  'home.labelActiveIn': 'Active',
  'home.labelSwitch': 'Switch',

  // --- permissionStatus ---
  'perm.title': '🔐 **Permission Status**',
  'perm.mode': 'Mode',
  'perm.remembered': 'Remembered in this session',
  'perm.pendingApproval': 'Pending approval',
  'perm.lastDecision': 'Last decision',
  'perm.decisionAllow': 'Allow once',
  'perm.decisionAllowSameCommand': 'Allow same command',
  'perm.decisionAllowSessionAll': 'Allow all in session',
  'perm.decisionAlwaysAllow': 'Always allow in session',
  'perm.decisionDeny': 'Denied',
  'perm.decisionCancelled': 'Cancelled',
  'perm.btnTurnOff': '⚡ Turn Off',
  'perm.btnTurnOn': '🔐 Turn On',
  'perm.btnHome': '🏠 Home',
  'perm.labelMode': 'Current config',
  'perm.labelModeOn': 'Approval on',
  'perm.labelModeOff': 'Approval off',
  'perm.labelResult': 'Result',
  'perm.labelSession': 'Session',
  'perm.labelSessionMemory': 'Session memory',
  'perm.labelTools': 'Tools',
  'perm.labelBashPrefixes': 'Bash prefixes',
  'perm.labelNoPending': 'None',
  'perm.labelQuestion': 'Question',
  'perm.labelOptions': 'Options',
  'perm.labelDescription': 'Description',
  'perm.hintClickToggle': '💡 Click options to toggle, then Submit.',
  'perm.hintClickOrText': '💡 Click an option or reply with text.',
  'perm.placeholderSelect': 'Select an option...',
  'perm.placeholderText': 'Or type your answer...',
  'perm.placeholderTextInput': 'Type your answer...',
  'perm.labelToolRequest': 'Tool request',
  'perm.labelSessionInfo': 'Session',
  'perm.hintInputSubmit': '💡 Type input then Submit, or reply directly.',
  'perm.placeholderInput': 'Type input...',
  'perm.btnSubmit': '✅ Submit',
  'perm.btnSubmitText': '✅ Submit text',
  'perm.btnSkip': '⏭️ Skip',
  'perm.hintMultiSelect': 'Click options to toggle, then Submit; or reply with text.',

  // --- taskStart ---
  'taskStart.resetTitle': '🔄 **Session reset, starting new task**',
  'taskStart.title': '🚀 **Starting task**',
  'taskStart.directory': 'Directory',
  'taskStart.permMode': 'Permission mode',
  'taskStart.permOn': 'on',
  'taskStart.previousSession': 'Previous session',
  'taskStart.btnSettings': '⚡ Settings',
  'taskStart.btnNew': '🆕 New',

  // --- newSession ---
  'newSession.title': '✅ **New Session**',
  'newSession.feedbackText': '🆕 Old session preserved, new session started',

  // --- taskSummary ---
  'taskSummary.title': '✅ **Task Summary**',
  'taskSummary.changedFiles': 'Changed files',
  'taskSummary.permissionPrompts': 'Permission prompts',
  'taskSummary.statusError': 'Has errors',
  'taskSummary.statusDone': 'Completed',
  'taskSummary.btnHome': '🏠 Home',
  'taskSummary.btnRecent': '🕘 Recent',
  'taskSummary.labelResult': 'Result',

  // --- progress buttons ---
  'progress.btnSessions': '🕘 Recent',
  'progress.btnNew': '🆕 New',
  'progress.btnHelp': '❓ Help',
  'progress.btnStop': '⏹ Stop',
  'progress.phaseThinking': 'Thinking',
  'progress.phaseCompleted': 'On completion',
  'progress.phaseFailed': 'On failure',
  'progress.phaseRunning': 'Running',
  'progress.labelThinkingProcess': '💭 Thinking',
  'progress.labelToolCalls': '🔧 Tool calls',
  'progress.labelToolSummary': '📝 Tool summary',
  'progress.labelWorkProgress': 'Work progress',
  'progress.labelCurrentWait': 'Currently waiting',
  'progress.labelPendingApprovals': 'Pending approvals',
  'progress.labelElapsedTime': 'Elapsed time',
  'progress.labelRecentAction': 'Recent action',
  'progress.labelStepsCompleted': 'steps completed',
  'progress.titleCompleted': '✅ Completed',
  'progress.titleStopped': '⚠️ Stopped',
  'progress.titleWaitingPerm': '🔐 Waiting for permission',
  'progress.titleContinue': '🔄 Continue',
  'progress.titleStarting': '⏳ Starting',
  'progress.titleRunning': '⏳ Running',
  'progress.apiRetry': '🔄 API retry',
  'progress.compacting': '📦 Compacting context...',
  'progress.andMore': 'and more',

  // --- versionUpdate ---
  'version.title': '🔄 **Update Available**',
  'version.released': 'Released',

  // --- multiSelectToggle ---
  'multiSelect.hint': '💬 Tap options to toggle, then Submit',

  // --- text-dispatcher ---
  'dispatcher.multiPermHint':
    '⚠️ Multiple permissions pending — reply to the specific permission message',

  // --- progress ---
  'progress.starting': '⏳ Starting',
  'progress.executing': '⏳ Running',
  'progress.waitingPermission': '🔐 Waiting for permission',
  'progress.completed': '✅ Completed',
  'progress.failed': '⚠️ Failed',
  'progress.taskLabel': 'Task',
  'progress.timeLabel': 'Time',

  // --- format ---
  'format.justNow': 'just now',
  'format.continueTask': 'Continue current task',
  'format.taskCompleted': 'Task completed',
  'format.labelStatus': 'Status',
  'format.labelChannel': 'Channel',
  'format.labelSession': 'Session',
  'format.labelMemory': 'Memory',
  'format.labelUptime': 'Uptime',
  'format.labelVersion': 'Version',
  'format.labelDirectory': 'Directory',
  'format.labelResultSummary': 'Result summary',
  'format.labelCurrentConfig': 'Current config',
  'format.labelPreviousSession': 'Previous session',
  'format.labelResult': 'Result',
  'format.labelChangedFiles': 'Changed files',
  'format.labelPermissionRequests': 'Permission requests',
  'format.seconds': 's',
  'format.minutes': 'm',
  'format.hours': 'h',
  'format.days': 'd',
  'format.activeAgo': 'ago',
  'format.taskStartHint': '💡 Task started. Adjust config via buttons below.',
  'format.titleStatus': '📊 TLive Status',
  'format.titleHome': '🏠 Dashboard',
  'format.titlePermissionStatus': '🔐 Permission Status',
  'format.titleQuestion': '❓ Waiting for Answer',
  'format.titleDeferredInput': '⏳ Input Required',
  'format.titleTaskReset': '🔄 Session Reset',
  'format.titleTaskStart': '🚀 Starting',
  'format.titleTaskEnd': '⚠️ Task Ended',
  'format.titleTaskSummary': '✅ Task Summary',
  'format.titleDiagnose': '🩺 Diagnose',
  'format.statusRunning': 'Running',
  'format.statusDisconnected': 'Disconnected',
  'format.statusActive': 'Active',
  'format.statusIdle': 'Idle',
  'format.statusTotal': 'Total',
  'format.queueEmpty': 'Queue is empty',
  'format.flushErrorTitle': 'Message send failed',
  'format.flushErrorHint':
    'Possible cause: content exceeds platform limits (e.g., table rows, message length).',

  // --- diagnose ---
  'diagnose.labelSessions': 'Sessions',
  'diagnose.labelQueuedMessages': 'Queued messages',
  'diagnose.labelProcessingChats': 'Processing chats',
  'diagnose.labelBubbleMappings': 'Card route cache (memory)',
  'diagnose.labelPersistedBindings': 'Persisted bindings',
  'diagnose.labelPersistedTopicSessions': 'Persisted topics',
  'diagnose.labelCurrentChat': 'current chat',
  'diagnose.labelQueueUtilization': 'Queue utilization',
  'diagnose.labelSaturatedSessions': 'Saturated sessions',
  'diagnose.labelBusiestSession': 'Busiest session',
  'diagnose.labelQueueDetail': 'Queue detail',

  // --- adapter ---
  'adapter.submitted': 'Submitted',
  'adapter.processing': 'Processing...',

  // --- input recognition ---
  'input.skip': 'skip',
  'input.allow': 'allow',
  'input.allowAlways': 'always',
  'input.deny': 'deny',
  'input.skipped': '⏭ Skipped',
  'input.submitted': '✅ Input submitted:',

  // --- recent projects ---
  'recentProjects.hint': '💡 Use /cd <path> to switch directory',

  // --- error notification ---
  'error.title': '❌ Processing failed',
  'error.requestId': 'Request ID',

  // --- formatter ---
  'formatter.runInfo': 'Run info',
  'formatter.sessionNone': 'none',
  'formatter.sessionRunningLabel': 'running',
  'formatter.sessionIdleLabel': 'idle',
  'formatter.interactiveMode': 'interactive',
  'formatter.turnBasedMode': 'turn-based',
  'formatter.toolApprovalRequired': 'tool approval required',
  'formatter.toolCallsAutoAllowed': 'tool calls auto-allowed',
  'formatter.topicPermissionStatus': 'This topic has {status}.',
  'formatter.codexPermissionNote': 'Codex permissions are controlled by sandbox / approval policy.',
  'formatter.codexSlashNote':
    'The Codex SDK does not expose CLI slash autocomplete; this card shows TLive controls.',
  'formatter.otherSlashPassThrough': 'Other slash commands pass through to the current agent.',
  'formatter.currentSession': 'Current session',
  'formatter.capabilities': 'Capabilities',
  'formatter.basicChat': 'chat',
  'formatter.imageInput': 'images',
  'formatter.instantSteer': 'steer',
  'formatter.queueCapability': 'queue',
  'formatter.sessionActions': '⌘ Session actions',
  'formatter.directory': 'Directory',

  // --- format-home ---
  'home.newSessionDefaultWorkspace': '**New session default workspace**',
  'home.statusCanContinue': '✅ Can continue',
  'home.btnBackToTopic': 'Back to topic',
  'home.btnResumeToTopic': 'Resume to topic',
  'home.panelRecentTopics': '💬 Recent session topics',
  'home.panelRecentLocalSessions': '🧭 Recent local sessions',
  'home.panelDiagnostics': '🛠️ Diagnostics',
  'home.btnViewRecentSessions': 'View recent sessions',
  'home.btnViewLocalHistory': 'View local history',
  'home.btnBridgeStatus': 'Bridge Status',
  'home.btnInternalDiagnose': 'Internal diagnose',
  'home.commandPlaceholder': 'Enter TLive command, e.g. cd /repo, bash pwd',
  'home.btnExecute': 'Execute',

  // --- message-loop ---
  'msgLoop.replyTargetMissing':
    '⚠️ Referenced session is invalid, please send message directly or switch session',
  'msgLoop.sendFailed': '⚠️ Session injection failed, please try again later',
  'msgLoop.busyUnsupported':
    '⚠️ Current provider does not support message insertion during execution, please wait or use /stop',
  'msgLoop.noActiveSession': '⚠️ No active session, please start a task first',
  'msgLoop.queueFull': '⚠️ Queue is full ({depth}/{maxDepth}), please try again later',
  'msgLoop.processFailed': '⚠️ Session processing failed, please try again later',
  'msgLoop.inserted': '💬 Inserted into current session',
  'msgLoop.queued':
    '📥 Queued (position {position}/{maxDepth}), will process after current task completes',

  // --- presenter ---
  'presenter.currentDir': '📂 Current directory: ',
  'presenter.workspaceBinding': '🏠 Workspace binding: ',
  'presenter.dirHistory': '📋 Directory history: ',
  'presenter.totalCount': '{count} total',
  'presenter.cdHint': '💡 Use /cd - to return to previous directory',
  'presenter.settingsUnavailable':
    '⚠️ Current execution engine does not support settings source switching',

  // --- cost-tracker ---
  'cost.input': 'input',
  'cost.output': 'output',
  'cost.reasoning': 'reasoning',
  'cost.cached': 'cached',

  // --- format-session-list ---
  'sessionList.stateRunning': 'Running',
  'sessionList.stateCurrent': 'Current',
  'sessionList.stateCanContinue': 'Can continue',
  'sessionList.roleAssistant': 'Assistant',
  'sessionList.roleUser': 'User',
  'sessionList.recentMessages': '**Recent messages**',
  'sessionList.topic': '**Topic**',
  'sessionList.workspace': '**Workspace**',
  'sessionList.preview': '**Update preview**',

  // --- home-command ---
  'homeCmd.description': 'Show home screen',
  'homeCmd.helpDesc':
    'Display main control panel with current session status, recent sessions, workspace switch buttons. Main entry for workspace management.',
  'homeCmd.tliveDescription': 'Open workbench',
  'homeCmd.tliveHelpDesc':
    'Open TLive workbench. Main window for new sessions, returning to topics and diagnostics; /stop only interrupts tasks within specific topics.',
  'homeCmd.recentTopicsTitle': 'Recent session topics',
  'homeCmd.recentTopicsEmpty': 'No topic sessions to continue',
  'homeCmd.btnBackToTopic': 'Back to topic',
  'homeCmd.recentLocalTitle': 'Recent local sessions',
  'homeCmd.recentLocalEmpty': 'No recoverable local session history',
  'homeCmd.btnResumeToTopic': 'Resume to topic',

  // --- topic-resume ---
  'topicResume.sessionPreview': '{provider} session',
  'topicResume.connected':
    '💬 Connected to {provider} session `{sessionId}` · {cwd}\n\nPlease continue sending messages in this topic.',
  'topicResume.sessionNotFound': '⚠️ {provider} session not found, may have been cleaned up.',
  'topicResume.resumed':
    '▶️ Returned to {provider} session `{sessionId}`\n\nPlease send messages in this topic to continue.',
  'topicResume.anchorMissing':
    '⚠️ Session record found but missing topic message anchor, please reopen topic from workbench.',
  'topicResume.fromWorkbench': '⚠️ Please recover history session from workbench.',
  'topicResume.createFailed': '⚠️ Cannot create topic, history session not recovered.',

  // --- progress-builder ---
  'progress.engineLabel': 'Engine {name}',
  'progress.thinkingLabel': 'Thinking {effort}',
  'progress.continueExec': '🔄 Continuing... ({steps} steps completed)',

  // --- markdown ---
  'markdown.tableChunk': '**Table {index}/{total}**',

  // --- upgrade command ---
  'cmd.upgrade.description': 'Upgrade version',
  'cmd.upgrade.helpDesc':
    'Check and upgrade to latest version. Service will restart automatically. Use notes to view changelog.',
  'cmd.upgrade.notesHint': '📋 View changelog:\nhttps://github.com/huanghuoguoguo/tlive/releases',
  'cmd.upgrade.checkFailed': '⚠️ Cannot check for updates, please try again later',
  'cmd.upgrade.alreadyLatest': '✅ Already at latest version v{version}',
  'cmd.upgrade.gitCheckout':
    '⚠️ Running from git checkout, please update manually with git or use release version.',
  'cmd.upgrade.starting': '🔄 Starting upgrade: v{current} → v{latest}\nService will restart...',
  'cmd.upgrade.failed': '❌ Upgrade failed: {error}',

  // --- new command ---
  'cmd.new.description': 'New session',
  'cmd.new.helpDesc':
    'Create a new topic session in workbench; use /new <engine> to select execution engine.',
  'cmd.new.unsupportedType': '⚠️ Unsupported session type: {type}. Available: {available}',
  'cmd.new.providerUnavailable': '⚠️ {provider} provider is currently unavailable.',
  'cmd.new.reason': 'Reason: {reason}',
  'cmd.new.topicTitle': 'New {provider} session',
  'cmd.new.topicIntro': '💬 New topic opened, please continue sending messages in this topic.',

  // --- cd command ---
  'cmd.cd.description': 'Change directory',
  'cmd.cd.helpDesc':
    'Change current IM session working directory, affects bash execution directory. Does not modify engine config. To work in new workspace, first /cd then /new.',
  'cmd.cd.noHistory': '⚠️ No previous directory to return to',
  'cmd.cd.switchedBack': '🔙 Switched to previous directory',
  'cmd.cd.switchedRepo': '🧭 Old repo session preserved, switched to new directory',

  // --- stop command ---
  'cmd.stop.description': 'Stop execution',
  'cmd.stop.helpDesc':
    'Interrupt current running task. Used to stop long-running commands or AI reply generation.',
  'cmd.stop.workbenchHint':
    '⚠️ /stop only interrupts tasks within specific topics. Please enter the executing topic to stop.',

  // --- perm command ---
  'cmd.perm.description': 'Permission mode',
  'cmd.perm.helpDesc':
    'View or switch permission prompt mode. on requires confirmation for each tool call, off auto-allows.',

  // --- deferred-tool ---
  'deferred.hint': '💬 Type input or reply "{skip}"',
  'deferred.btnLabel': '{icon} {action}',

  // --- policy ---
  'policy.imageAccepted': '✅ Image accepted',
  'policy.imageRejected': '❌ Image rejected',
  'policy.imageRejectedReason': '❌ Image rejected: {reason}',

  // --- session-format ---
  'format.minAgo': '{count} min ago',
  'format.hourAgo': '{count}h ago',
  'format.dayAgo': '{count}d ago',

  // --- main ---
  'main.upgradeSuccess':
    '✅ Upgrade successful\nVersion: v{previous} → v{version}\nView changelog: https://github.com/huanghuoguoguo/tlive/releases',
  'main.upgradeFailed': '❌ Upgrade failed\nError: {error}\nVersion: v{previous}',

  // --- buttons ---
  'btn.stopExec': '⏹ Stop',
  'btn.newSession': '🆕 New',

  // --- adapter ---
  'adapter.acceptedImage': '✅ Image accepted',
  'adapter.processingImage': 'Processing image...',

  // --- surface-policy ---
  'surface.steerUnsupported': '⚠️ Current provider does not support instant steer',
  'surface.queueUnsupported': '⚠️ Current provider does not support message queue',

  // --- topic-conversation ---
  'topic.agentSession': 'Agent session',
  'topic.started': '💬 Topic started, processing...',

  // --- home-model ---
  'homeModel.bound': 'Bound',
  'homeModel.unbound': 'Unbound',

  // --- command-router ---
  'router.unknownCommand': '❓ Unknown command: {cmd}',
  'router.workbenchCommandHint':
    '⚠️ {cmd} is a TLive workbench command. Please use the command input or buttons in /tlive workbench.',

  // --- sdk-perm-tracker ---
  'sdkPerm.tracking': 'Tracking',
  'sdkPerm.notTracking': 'Not tracking',

  // --- form-callbacks ---
  'formCmd.executed': '✅ Command executed',

  // --- query ---
  'query.replyMissing':
    '⚠️ Referenced session is invalid, please send message directly or switch session',

  // --- query-recovery ---
  'queryRecovery.sessionMissing': '⚠️ No active session, please start a task first',

  // --- continue command ---
  'cmd.continue.description': 'Continue topic',

  // --- help-categories ---
  'helpCat.session': 'Session',
  'helpCat.status': 'Status',
  'helpCat.system': 'System',
  'helpCat.agent': 'Agent',
  'helpCat.other': 'Other',
  'helpCat.sessionDesc': 'Session management',
  'helpCat.statusDesc': 'View status',
  'helpCat.systemDesc': 'System control',
  'helpCat.agentDesc': 'Agent related',

  // --- other commands ---
  'cmd.status.description': 'Bridge status',
  'cmd.settings.description': 'Settings source',
  'cmd.restart.description': 'Restart service',
  'cmd.pwd.description': 'Current directory',
  'cmd.help.description': 'Show help',
  'cmd.diagnose.description': 'Internal diagnose',
  'cmd.bash.description': 'Execute command',

  // --- feishu adapter ---
  'feishu.topicProcessing': '💬 Topic started, processing...',
  'feishu.topicContinue': '💬 Topic started, please continue in this topic...',

  // --- ui buttons ---
  'btn.newProviderSession': '🆕 New {provider} session',

  // --- surface rejection ---
  'surface.tliveRejection':
    '⚠️ /tlive is a workbench command, only available in main chat. This topic is bound to an Agent session, please continue conversation here.',
  'surface.homeRejection':
    '⚠️ /home is a workbench command, only available in main chat. This topic is bound to an Agent session, please continue conversation here.',
  'surface.continueRejection':
    '⚠️ Topic is bound to current Agent session, cannot switch to other sessions.',

  // --- deferred-tool handler ---
  'deferredTool.planModePrompt':
    'Agent wants to enter Plan mode to plan the task. Enter your plan content, or confirm to enter plan mode directly.',
  'deferredTool.planModePlaceholder': 'Enter plan content (optional)...',
  'deferredTool.worktreePrompt':
    'Agent wants to create a new git worktree to isolate work. Enter branch name (optional).',
  'deferredTool.worktreePlaceholder': 'Enter branch name (optional)...',
  'deferredTool.toolInputPrompt': 'Tool {toolName} requires user input. Please provide input.',
  'deferredTool.toolInputPlaceholder': 'Enter input...',

  // --- help format ---
  'help.exampleLabel': '📌 Example',

  // --- form callbacks ---
  'formCmd.enterCommand': '⚠️ Please enter a TLive command.',

  // --- permission input keywords ---
  'input.allowKeywords': 'pass',
  'input.denyKeywords': 'no',

  // --- presenter stop ---
  'presenter.stopInterrupted': '⏹ Interrupted current execution',
  'presenter.stopNoExecution': '⚠️ No active execution to stop',

  // --- continue command ---
  'cmd.continue.usage': '⚠️ Usage: /continue <provider>:<sdkSessionId>',

  // --- form validation ---
  'form.invalidSelection': '⚠️ Invalid selection, please try again.',
  'form.submitWithoutAnswer': '⚠️ Please enter an answer or choose an option before submitting.',

  // --- query recovery ---
  'queryRecovery.staleSessionFallback': '🔄 Old session unrecoverable, started a new session for you',

  // --- home model ---
  'homeModel.agentSession': 'Agent session',
};
