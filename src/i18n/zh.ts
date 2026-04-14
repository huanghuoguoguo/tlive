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

  // --- home ---
  'home.taskActive': '有任务正在执行',
  'home.taskIdle': '无执行中任务',
  'home.workspaceBinding': '工作区绑定',
  'home.recentSessions': '**最近会话**',
  'home.btnSessions': '🕘 最近会话',
  'home.btnPermissions': '🔐 权限设置',
  'home.btnNew': '🆕 新会话',
  'home.btnHelp': '❓ 帮助',

  // --- permissionStatus ---
  'perm.title': '🔐 **权限状态**',
  'perm.mode': '当前模式',
  'perm.remembered': '本会话已记住',
  'perm.pendingApproval': '当前待审批',
  'perm.lastDecision': '最近处理',
  'perm.decisionAllow': '允许一次',
  'perm.decisionAlwaysAllow': '本会话始终允许',
  'perm.decisionDeny': '拒绝',
  'perm.decisionCancelled': '已取消',
  'perm.btnTurnOff': '⚡ 关闭审批',
  'perm.btnTurnOn': '🔐 开启审批',
  'perm.btnHome': '🏠 首页',

  // --- taskStart ---
  'taskStart.resetTitle': '🔄 **会话已重置，开始新任务**',
  'taskStart.title': '🚀 **开始执行**',
  'taskStart.directory': '目录',
  'taskStart.permMode': '权限模式',
  'taskStart.permOn': '开启审批',
  'taskStart.previousSession': '上次会话',
  'taskStart.btnSettings': '⚡ 调整配置',
  'taskStart.btnNew': '🆕 新会话',

  // --- sessions ---
  'sessions.footer': '\n使用 /session <n> 切换',

  // --- newSession ---
  'newSession.title': '✅ **新会话**',

  // --- taskSummary ---
  'taskSummary.title': '✅ **任务摘要**',
  'taskSummary.changedFiles': '改动文件',
  'taskSummary.permissionPrompts': '权限审批',
  'taskSummary.statusError': '有错误',
  'taskSummary.statusDone': '已完成',
  'taskSummary.btnHome': '🏠 首页',
  'taskSummary.btnRecent': '🕘 最近会话',

  // --- progress buttons ---
  'progress.btnSessions': '🕘 最近会话',
  'progress.btnNew': '🆕 新会话',
  'progress.btnHelp': '❓ 帮助',
  'progress.btnStop': '⏹ 停止执行',

  // --- versionUpdate ---
  'version.title': '🔄 **发现新版本**',
  'version.released': '发布时间',

  // --- multiSelectToggle ---
  'multiSelect.hint': '💬 点击选项切换，然后按 Submit 确认',

  // --- text-dispatcher ---
  'dispatcher.multiPermHint': '⚠️ 多个权限待审批，请引用回复具体的权限消息',

  // --- qqbot progress ---
  'progress.starting': '⏳ 准备开始',
  'progress.executing': '⏳ 执行中',
  'progress.waitingPermission': '🔐 等待权限',
  'progress.completed': '✅ 已完成',
  'progress.failed': '⚠️ 已停止',
  'progress.taskLabel': '任务',
  'progress.timeLabel': '耗时',
};
