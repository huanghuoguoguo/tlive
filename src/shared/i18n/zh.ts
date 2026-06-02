import type { Translations } from './types.js';

export const zh: Translations = {
  // --- question ---
  'question.multiSelectHint': '💬 点击选项切换，然后按 Submit 确认',
  'question.singleSelectHint': '💬 回复数字选择，或直接输入内容',

  // --- deferredToolInput ---
  'deferred.title': '⏳ **等待输入**',
  'deferred.toolLabel': '工具',
  'deferred.descLabel': '说明',
  'deferred.inputHint': '💬 输入内容或回复 "跳过"',
  'deferred.btnSubmit': '✅ 提交',
  'deferred.btnSkip': '⏭ 跳过',

  // --- home ---
  'home.taskActive': '有任务正在执行',
  'home.taskIdle': '无执行中任务',
  'home.workspaceBinding': '工作区绑定',
  'home.activeSessions': '活跃会话',
  'home.recentSessions': '**最近会话**',
  'home.btnPermissions': '🔐 权限设置',
  'home.btnNew': '🆕 新会话',
  'home.btnHelp': '❓ 帮助',
  'home.statusExecuting': '执行中',
  'home.statusActive': '活跃',
  'home.statusIdle': '空闲',
  'home.labelNone': '无',
  'home.labelSdkSession': 'SDK会话',
  'home.labelSdkUnbound': '未绑定',
  'home.labelQueue': '队列',
  'home.labelQueuePending': '条待处理',
  'home.labelCurrentSession': '当前会话',
  'home.labelDirectory': '目录',
  'home.labelPermission': '权限',
  'home.labelStatus': '状态',
  'home.labelHistory': '历史',
  'home.labelGlobal': '全局',
  'home.labelRecentChat': '最近对话',
  'home.labelSize': '大小',
  'home.labelActiveIn': '活跃中',
  'home.labelSwitch': '切换',

  // --- permissionStatus ---
  'perm.title': '🔐 **权限状态**',
  'perm.mode': '当前模式',
  'perm.remembered': '本会话已记住',
  'perm.pendingApproval': '当前待审批',
  'perm.lastDecision': '最近处理',
  'perm.decisionAllow': '允许一次',
  'perm.decisionAllowSameCommand': '允许相同命令',
  'perm.decisionAllowSessionAll': '本 session 全部允许',
  'perm.decisionAlwaysAllow': '本会话始终允许',
  'perm.decisionDeny': '拒绝',
  'perm.decisionCancelled': '已取消',
  'perm.btnTurnOff': '⚡ 关闭审批',
  'perm.btnTurnOn': '🔐 开启审批',
  'perm.btnHome': '🏠 首页',
  'perm.labelMode': '当前配置',
  'perm.labelModeOn': '开启审批',
  'perm.labelModeOff': '关闭审批',
  'perm.labelResult': '执行结果',
  'perm.labelSession': '会话',
  'perm.labelSessionMemory': '本会话记忆',
  'perm.labelTools': '工具',
  'perm.labelBashPrefixes': 'Bash 前缀',
  'perm.labelNoPending': '暂无',
  'perm.labelQuestion': '问题',
  'perm.labelOptions': '选项',
  'perm.labelDescription': '说明',
  'perm.hintClickToggle': '💡 点击选项切换勾选，然后点提交。',
  'perm.hintClickOrText': '💡 点击选项或直接回复文字。',
  'perm.placeholderSelect': '选择一个选项...',
  'perm.placeholderText': '或直接输入文字回答...',
  'perm.placeholderTextInput': '直接输入文字回答...',
  'perm.labelToolRequest': '工具请求',
  'perm.labelSessionInfo': '会话',
  'perm.hintInputSubmit': '💡 输入内容后点击提交，或直接回复文字。',
  'perm.placeholderInput': '输入内容...',
  'perm.btnSubmit': '✅ 提交',
  'perm.btnSubmitText': '✅ 提交文字',
  'perm.btnSkip': '⏭️ 跳过',
  'perm.hintMultiSelect': '点击选项切换勾选，然后点 Submit；也可以直接回复文字。',

  // --- taskStart ---
  'taskStart.resetTitle': '🔄 **会话已重置，开始新任务**',
  'taskStart.title': '🚀 **开始执行**',
  'taskStart.directory': '目录',
  'taskStart.permMode': '权限模式',
  'taskStart.permOn': '开启审批',
  'taskStart.previousSession': '上次会话',
  'taskStart.btnSettings': '⚡ 调整配置',
  'taskStart.btnNew': '🆕 新会话',

  // --- newSession ---
  'newSession.title': '✅ **新会话**',
  'newSession.feedbackText': '🆕 已保留旧会话，开启新会话',

  // --- taskSummary ---
  'taskSummary.title': '✅ **任务摘要**',
  'taskSummary.changedFiles': '改动文件',
  'taskSummary.permissionPrompts': '权限审批',
  'taskSummary.statusError': '有错误',
  'taskSummary.statusDone': '已完成',
  'taskSummary.btnHome': '🏠 首页',
  'taskSummary.btnRecent': '🕘 最近会话',
  'taskSummary.labelResult': '执行结果',

  // --- progress buttons ---
  'progress.btnSessions': '🕘 最近会话',
  'progress.btnNew': '🆕 新会话',
  'progress.btnHelp': '❓ 帮助',
  'progress.btnStop': '⏹ 停止执行',
  'progress.phaseThinking': '思考',
  'progress.phaseCompleted': '完成时',
  'progress.phaseFailed': '失败时',
  'progress.phaseRunning': '执行中',
  'progress.labelThinkingProcess': '💭 思考过程',
  'progress.labelToolCalls': '🔧 工具调用',
  'progress.labelToolSummary': '📝 工具调用摘要',
  'progress.labelWorkProgress': '工作进度',
  'progress.labelCurrentWait': '当前等待',
  'progress.labelPendingApprovals': '待处理审批',
  'progress.labelElapsedTime': '运行时长',
  'progress.labelRecentAction': '最近动作',
  'progress.labelStepsCompleted': '步已完成',
  'progress.titleCompleted': '✅ 已完成',
  'progress.titleStopped': '⚠️ 已停止',
  'progress.titleFailed': '❌ 失败',
  'progress.titleWaitingPerm': '🔐 等待权限',
  'progress.titleContinue': '🔄 继续执行',
  'progress.titleStarting': '⏳ 准备开始',
  'progress.titleRunning': '⏳ 执行中',
  'progress.apiRetry': '🔄 API 重试中',
  'progress.compacting': '📦 正在压缩上下文...',
  'progress.andMore': '等',

  // --- versionUpdate ---
  'version.title': '🔄 **发现新版本**',
  'version.current': '当前版本',
  'version.latest': '最新版本',
  'version.released': '发布时间',
  'version.notes': '更新内容',
  'version.upgradeAction': '升级',

  // --- multiSelectToggle ---
  'multiSelect.hint': '💬 点击选项切换，然后按 Submit 确认',

  // --- text-dispatcher ---
  'dispatcher.multiPermHint': '⚠️ 多个权限待审批，请引用回复具体的权限消息',

  // --- progress ---
  'progress.starting': '⏳ 准备开始',
  'progress.executing': '⏳ 执行中',
  'progress.waitingPermission': '🔐 等待权限',
  'progress.completed': '✅ 已完成',
  'progress.failed': '❌ 失败',
  'progress.taskLabel': '任务',
  'progress.timeLabel': '耗时',

  // --- format ---
  'format.justNow': '刚刚',
  'format.continueTask': '继续当前任务',
  'format.taskCompleted': '任务已完成',
  'format.labelStatus': '状态',
  'format.labelChannel': '通道',
  'format.labelSession': '会话',
  'format.labelMemory': '内存',
  'format.labelUptime': '运行时长',
  'format.labelVersion': '版本',
  'format.labelDirectory': '目录',
  'format.labelResultSummary': '结果摘要',
  'format.labelCurrentConfig': '当前配置',
  'format.labelPreviousSession': '上次会话',
  'format.labelResult': '执行结果',
  'format.labelChangedFiles': '改动文件',
  'format.labelPermissionRequests': '权限审批',
  'format.seconds': '秒',
  'format.minutes': '分钟',
  'format.hours': '小时',
  'format.days': '天',
  'format.activeAgo': '前活跃',
  'format.taskStartHint': '💡 任务已开始执行。如需调整配置，点击下方按钮。',
  'format.titleStatus': '📊 TLive 状态',
  'format.titleHome': '🏠 工作台',
  'format.titlePermissionStatus': '🔐 权限状态',
  'format.titleQuestion': '❓ 等待回答',
  'format.titleDeferredInput': '⏳ 等待输入',
  'format.titleTaskReset': '🔄 会话已重置',
  'format.titleTaskStart': '🚀 开始执行',
  'format.titleTaskEnd': '⚠️ 任务结束',
  'format.titleTaskSummary': '✅ 任务摘要',
  'format.titleDiagnose': '🩺 内部诊断',
  'format.statusRunning': '运行中',
  'format.statusDisconnected': '已断开',
  'format.statusActive': '活跃',
  'format.statusIdle': '空闲',
  'format.statusTotal': '共',
  'format.queueEmpty': '队列已为空',
  'format.flushErrorTitle': '消息发送失败',
  'format.flushErrorHint': '可能原因：内容超出平台限制（如表格行数、消息长度）。',

  // --- diagnose ---
  'diagnose.labelSessions': '会话',
  'diagnose.labelQueuedMessages': '排队消息',
  'diagnose.labelProcessingChats': '处理中对话',
  'diagnose.labelBubbleMappings': '卡片路由缓存（内存）',
  'diagnose.labelPersistedBindings': '持久化绑定',
  'diagnose.labelPersistedTopicSessions': '持久化话题',
  'diagnose.labelCurrentChat': '当前聊天',
  'diagnose.labelQueueUtilization': '队列使用率',
  'diagnose.labelSaturatedSessions': '队列已满会话',
  'diagnose.labelBusiestSession': '最忙会话',
  'diagnose.labelQueueDetail': '队列详情',

  // --- adapter ---
  'adapter.submitted': '已提交',
  'adapter.processing': '处理中...',

  // --- input recognition ---
  'input.skip': '跳过',
  'input.allow': '允许',
  'input.allowAlways': '始终允许',
  'input.deny': '拒绝',
  'input.skipped': '⏭ 已跳过',
  'input.submitted': '✅ 已提交输入:',

  // --- recent projects ---
  'recentProjects.hint': '💡 使用 /cd <路径> 切换目录',

  // --- error notification ---
  'error.title': '❌ 处理失败',
  'error.requestId': '请求ID',

  // --- formatter ---
  'formatter.runInfo': '运行信息',
  'formatter.sessionNone': '未建立',
  'formatter.sessionRunningLabel': '执行中',
  'formatter.sessionIdleLabel': '空闲',
  'formatter.interactiveMode': '交互式',
  'formatter.turnBasedMode': '按回合',
  'formatter.toolApprovalRequired': '工具调用需要确认',
  'formatter.toolCallsAutoAllowed': '工具调用自动允许',
  'formatter.topicPermissionStatus': '本话题{status}。',
  'formatter.codexPermissionNote':
    'Codex 的权限由 sandbox / approval policy 控制，不提供 Claude 式逐工具审批。',
  'formatter.codexSlashNote':
    'Codex SDK 当前不暴露 CLI 里的 slash 自动补全；这里显示 TLive 能控制的会话操作。',
  'formatter.otherSlashPassThrough': '其它 slash 命令会透传给当前 Agent。',
  'formatter.currentSession': '当前会话',
  'formatter.capabilities': '能力',
  'formatter.basicChat': '基础对话',
  'formatter.imageInput': '图片输入',
  'formatter.instantSteer': '即时插话',
  'formatter.queueCapability': '队列',
  'formatter.sessionActions': '⌘ 会话操作',
  'formatter.directory': '目录',

  // --- format-home ---
  'home.newSessionDefaultWorkspace': '**新会话默认工作区**',
  'home.statusCanContinue': '✅ 可继续',
  'home.btnBackToTopic': '回到话题',
  'home.btnResumeToTopic': '恢复到话题',
  'home.panelRecentTopics': '💬 最近会话话题',
  'home.panelRecentLocalSessions': '🧭 最近本地会话',
  'home.panelDiagnostics': '🛠️ 诊断',
  'home.btnViewRecentSessions': '查看最近会话',
  'home.btnViewLocalHistory': '查看本地历史',
  'home.btnBridgeStatus': 'Bridge 状态',
  'home.btnInternalDiagnose': '内部诊断',
  'home.commandPlaceholder': '输入 TLive 命令，例如 cd /repo、bash pwd',
  'home.btnExecute': '执行',

  // --- message-loop ---
  'msgLoop.replyTargetMissing': '⚠️ 引用的会话已失效，请直接发送消息或切换会话后重试',
  'msgLoop.sendFailed': '⚠️ 会话注入失败，请稍后重试',
  'msgLoop.busyUnsupported': '⚠️ 当前 provider 不支持执行中插入消息，请等待完成或使用 /stop',
  'msgLoop.noActiveSession': '⚠️ 无活跃会话，请先开始任务',
  'msgLoop.queueFull': '⚠️ 排队已满（{depth}/{maxDepth}），请稍后再发',
  'msgLoop.processFailed': '⚠️ 会话处理失败，请稍后重试',
  'msgLoop.inserted': '💬 已插入当前会话',
  'msgLoop.queued': '📥 已排队（位置 {position}/{maxDepth}），当前任务结束后继续处理',

  // --- presenter ---
  'presenter.currentDir': '📂 当前目录：',
  'presenter.workspaceBinding': '🏠 工作区绑定：',
  'presenter.dirHistory': '📋 目录历史：',
  'presenter.totalCount': '共 {count} 个',
  'presenter.cdHint': '💡 使用 /cd - 返回上一目录',
  'presenter.settingsUnavailable': '⚠️ 当前执行引擎不支持设置源切换',

  // --- cost-tracker ---
  'cost.input': '输入',
  'cost.output': '输出',
  'cost.reasoning': '推理',
  'cost.cached': '缓存',

  // --- format-session-list ---
  'sessionList.stateRunning': '执行中',
  'sessionList.stateCurrent': '当前',
  'sessionList.stateCanContinue': '可继续',
  'sessionList.roleAssistant': '助手',
  'sessionList.roleUser': '用户',
  'sessionList.recentMessages': '**最近消息**',
  'sessionList.topic': '**话题**',
  'sessionList.executionNode': '**执行节点**',
  'sessionList.workspace': '**工作区**',
  'sessionList.preview': '**更新预览**',

  // --- home-command ---
  'homeCmd.description': '显示主界面',
  'homeCmd.helpDesc':
    '显示主控制面板，包括当前会话状态、历史会话列表、工作区切换按钮等。是查看和管理工作区的主要入口。',
  'homeCmd.tliveDescription': '打开工作台',
  'homeCmd.tliveHelpDesc':
    '打开 TLive 工作台。主窗口用于新建会话、回到话题和诊断；/stop 只在具体话题内中断任务。',
  'homeCmd.recentTopicsTitle': '最近会话话题',
  'homeCmd.recentTopicsEmpty': '暂无可继续的话题会话',
  'homeCmd.btnBackToTopic': '回到话题',
  'homeCmd.recentLocalTitle': '最近本地会话',
  'homeCmd.recentLocalEmpty': '暂无可恢复的本地历史会话',
  'homeCmd.recentSessionsTitle': '最近会话',
  'homeCmd.recentSessionsEmpty': '暂无可恢复的会话',
  'homeCmd.recentNodeTitle': '{clientId} 最近会话',
  'homeCmd.recentNodeEmpty': '{clientId} 暂无可恢复的会话',
  'homeCmd.btnResumeToTopic': '恢复到话题',

  // --- topic-resume ---
  'topicResume.sessionPreview': '{provider} 会话',
  'topicResume.connected':
    '💬 已连接 {provider} 会话 `{sessionId}` · {cwd}\n\n请在本话题内继续发送消息。',
  'topicResume.sessionNotFound': '⚠️ 未找到该 {provider} 会话，可能已被清理。',
  'topicResume.resumed': '▶️ 已回到 {provider} 会话 `{sessionId}`\n\n请在本话题内发送消息继续。',
  'topicResume.anchorMissing': '⚠️ 已找到会话记录，但缺少话题消息锚点，请从工作台重新开启话题。',
  'topicResume.fromWorkbench': '⚠️ 请从工作台恢复历史会话。',
  'topicResume.createFailed': '⚠️ 无法创建话题，未恢复历史会话。',

  // --- progress-builder ---
  'progress.engineLabel': '引擎 {name}',
  'progress.thinkingLabel': '思考 {effort}',
  'progress.continueExec': '🔄 继续执行... ({steps} 步已完成)',

  // --- markdown ---
  'markdown.tableChunk': '**表格 {index}/{total}**',

  // --- upgrade command ---
  'cmd.upgrade.description': '升级版本',
  'cmd.upgrade.helpDesc': '检查并升级到最新版本。服务会自动重启。notes 查看更新日志。',
  'cmd.upgrade.notesHint': '📋 查看更新内容：\nhttps://github.com/huanghuoguoguo/tlive/releases',
  'cmd.upgrade.checkFailed': '⚠️ 无法检查更新，请稍后重试',
  'cmd.upgrade.alreadyLatest': '✅ 已是最新版本 v{version}',
  'cmd.upgrade.alreadyRunning': '🔄 升级已在进行中{version}，请不要重复点击。',
  'cmd.upgrade.gitCheckout':
    '⚠️ 当前运行自 git checkout，请手动用 git 更新，或改用 release 安装版。',
  'cmd.upgrade.starting': '🔄 开始升级：v{current} → v{latest}\n服务将自动重启...',
  'cmd.upgrade.failed': '❌ 升级失败：{error}',

  // --- new command ---
  'cmd.new.description': '新建会话',
  'cmd.new.helpDesc': '在工作台中新建一个话题会话；可用 /new <engine> 选择执行引擎。',
  'cmd.new.unsupportedType': '⚠️ 不支持的会话类型: {type}。可用: {available}',
  'cmd.new.providerUnavailable': '⚠️ {provider} provider 当前不可用。',
  'cmd.new.reason': '原因: {reason}',
  'cmd.new.topicTitle': '新 {provider} 会话',
  'cmd.new.topicIntro': '💬 已开启新话题，请在本话题内继续发送消息。',

  // --- cd command ---
  'cmd.cd.description': '切换目录',
  'cmd.cd.helpDesc':
    '切换当前 IM session 的工作目录，影响后续 bash 执行的目录。不修改执行引擎配置。若要在新工作区开始工作，请先 /cd 切换目录，再执行 /new。',
  'cmd.cd.noHistory': '⚠️ 没有历史目录可返回',
  'cmd.cd.switchedBack': '🔙 已切换到上一目录',
  'cmd.cd.switchedRepo': '🧭 已保留旧仓库会话，默认切到新目录',

  // --- stop command ---
  'cmd.stop.description': '中断执行',
  'cmd.stop.helpDesc': '中断当前正在执行的任务。用于停止长时间运行的命令或 AI 回复生成。',
  'cmd.stop.workbenchHint': '⚠️ /stop 只中断具体话题内的当前任务。请进入正在执行的话题后停止。',

  // --- perm command ---
  'cmd.perm.description': '权限模式',
  'cmd.perm.helpDesc': '查看或切换权限提示模式。on 表示每次工具调用需确认，off 表示自动允许。',

  // --- deferred-tool ---
  'deferred.hint': '💬 输入内容或回复 "{skip}"',
  'deferred.btnLabel': '{icon} {action}',

  // --- policy ---
  'policy.imageAccepted': '✅ 图片已接受',
  'policy.imageRejected': '❌ 图片被拒绝',
  'policy.imageRejectedReason': '❌ 图片被拒绝：{reason}',

  // --- session-format ---
  'format.minAgo': '{count}分钟前',
  'format.hourAgo': '{count}小时前',
  'format.dayAgo': '{count}天前',

  // --- main ---
  'main.upgradeSuccess':
    '✅ 升级成功\n版本: v{previous} → v{version}\n查看更新: https://github.com/huanghuoguoguo/tlive/releases',
  'main.upgradeFailed': '❌ 升级失败\n错误: {error}\n版本: v{previous}',

  // --- buttons ---
  'btn.stopExec': '⏹ 停止执行',
  'btn.newSession': '🆕 新会话',

  // --- adapter ---
  'adapter.acceptedImage': '✅ 图片已接受',
  'adapter.processingImage': '处理图片中...',

  // --- surface-policy ---
  'surface.steerUnsupported': '⚠️ 当前 provider 不支持即时插话',
  'surface.queueUnsupported': '⚠️ 当前 provider 不支持消息队列',

  // --- topic-conversation ---
  'topic.agentSession': 'Agent 会话',
  'topic.started': '💬 已开启话题，正在处理...',

  // --- home-model ---
  'homeModel.bound': '绑定',
  'homeModel.unbound': '未绑定',

  // --- command-router ---
  'router.unknownCommand': '❓ 未知命令: {cmd}',
  'router.workbenchCommandHint':
    '⚠️ {cmd} 是 TLive 工作台命令。请在 /tlive 工作台的命令输入框或按钮中执行。',

  // --- sdk-perm-tracker ---
  'sdkPerm.tracking': '正在跟踪',
  'sdkPerm.notTracking': '未跟踪',

  // --- form-callbacks ---
  'formCmd.executed': '✅ 已执行命令',

  // --- query ---
  'query.replyMissing': '⚠️ 引用的会话已失效，请直接发送消息或切换会话后重试',

  // --- query-recovery ---
  'queryRecovery.sessionMissing': '⚠️ 无活跃会话，请先开始任务',

  // --- continue command ---
  'cmd.continue.description': '继续话题',

  // --- help-categories ---
  'helpCat.session': '会话',
  'helpCat.status': '状态',
  'helpCat.system': '系统',
  'helpCat.agent': 'Agent',
  'helpCat.other': '其他',
  'helpCat.sessionDesc': '会话管理',
  'helpCat.statusDesc': '查看状态',
  'helpCat.systemDesc': '系统控制',
  'helpCat.agentDesc': 'Agent 相关',

  // --- other commands ---
  'cmd.status.description': 'Bridge 状态',
  'cmd.settings.description': '设置源',
  'cmd.restart.description': '重启服务',
  'cmd.pwd.description': '当前目录',
  'cmd.help.description': '显示帮助',
  'cmd.diagnose.description': '内部诊断',
  'cmd.bash.description': '执行命令',

  // --- feishu adapter ---
  'feishu.topicProcessing': '💬 已开启话题，正在处理...',
  'feishu.topicContinue': '💬 已开启话题，请在本话题内继续...',

  // --- ui buttons ---
  'btn.newProviderSession': '🆕 新 {provider} 会话',

  // --- surface rejection ---
  'surface.tliveRejection':
    '⚠️ /tlive 是工作台命令，只能在主会话使用。当前话题已绑定一个 Agent 会话，请直接在本话题内继续对话。',
  'surface.homeRejection':
    '⚠️ /home 是工作台命令，只能在主会话使用。当前话题已绑定一个 Agent 会话，请直接在本话题内继续对话。',
  'surface.continueRejection': '⚠️ 话题内固定绑定当前 Agent 会话，不支持切换到其他会话。',

  // --- deferred-tool handler ---
  'deferredTool.planModePrompt':
    'Agent 想要进入 Plan 模式来规划任务。请输入你的计划内容，或直接确认进入计划模式。',
  'deferredTool.planModePlaceholder': '输入计划内容（可选）...',
  'deferredTool.worktreePrompt':
    'Agent 想要创建一个新的 git worktree 来隔离工作。请输入分支名称（可选）。',
  'deferredTool.worktreePlaceholder': '输入分支名称（可选）...',
  'deferredTool.toolInputPrompt': '工具 {toolName} 需要用户输入。请提供输入内容。',
  'deferredTool.toolInputPlaceholder': '输入内容...',

  // --- help format ---
  'help.exampleLabel': '📌 示例',

  // --- form callbacks ---
  'formCmd.enterCommand': '⚠️ 请输入 TLive 命令。',

  // --- permission input keywords ---
  'input.allowKeywords': '通过',
  'input.denyKeywords': '否',

  // --- presenter stop ---
  'presenter.stopInterrupted': '⏹ 已中断当前执行',
  'presenter.stopNoExecution': '⚠️ 无活跃执行可停止',

  // --- continue command ---
  'cmd.continue.usage': '⚠️ 用法: /continue <provider>:<sdkSessionId>',

  // --- form validation ---
  'form.invalidSelection': '⚠️ 选择无效，请重试。',
  'form.submitWithoutAnswer': '⚠️ 请先输入答案或选择选项后再提交。',

  // --- query recovery ---
  'queryRecovery.staleSessionFallback': '🔄 旧会话无法恢复，已为你开启新会话',

  // --- home model ---
  'homeModel.agentSession': 'Agent 会话',
};
