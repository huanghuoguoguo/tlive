# tlive 工作区治理规划

本文聚焦 `tlive` 的工作区治理能力，目标是在保留轻量设计的前提下，把当前的 `cwd` 概念演进成更可理解、更可持久、更适合长期使用的工作区状态。

## 背景与问题

当前 `tlive` 已经支持：

- `/cd`
- `/pwd`
- `/sessions`
- 基于会话扫描推断 `cwd`

这已经覆盖了基础目录操作，但还存在几个问题：

- 目录切换历史不持久
- 缺少“回到上一个目录”
- chat 和 repo 的关系不够显式
- “当前目录”和“当前项目”之间没有清晰区分

如果长期通过 IM 驱动 Claude，这些问题会逐步影响体验。

## 当前 tlive 现状

当前工作区模型基本可以概括为：

- 每个 chat binding 记录一个 `cwd`
- `/cd` 会直接更新 binding 中的 `cwd`
- `/sessions` 会按 `cwd` 过滤 Claude 会话
- `sdkSessionId` 可能随会话切换变化

优点：

- 简单直接
- 很适合单项目单 chat

限制：

- 目录只是一个值，不是一个可治理状态
- 缺少历史和回退能力
- 不能稳定表达“这个 chat 长期服务哪个 repo”

## 从 cc-connect 借鉴什么，不借鉴什么

借鉴：

- 目录历史持久化
- 上一个目录和历史序号切换
- workspace 绑定持久化
- 更明确的“工作区归属”

不借鉴：

- 直接上完整 multi-workspace 模式
- 自动 clone 仓库
- 复杂 channel-name 映射 workspace 规则

## 目标能力定义

第一阶段目标：

- 每个 chat 维护目录历史
- 支持快速回到上一个目录
- 支持查看最近目录
- 支持更清晰的“当前工作区”展示
- 为后续项目模型和 session 路由提供稳定基础

第一阶段不做：

- 自动仓库初始化
- 跨 chat 共享 workspace 池
- 复杂的 channel 自动映射规则

## 工作区模型建议

建议引入两个层次：

1. `current cwd`
2. `workspace binding`

其中：

- `current cwd` 表示当前本次对话默认目录
- `workspace binding` 表示这个 chat 长期服务的 repo 或工作区

这样可以区分：

- 临时切到一个子目录
- 这个 chat 的长期工作语义仍然属于哪个仓库

## 数据结构建议

建议新增持久数据：

- `workspaceHistoryByChat`
- `workspaceBindingByChat`

示例：

```json
{
  "telegram:12345": {
    "binding": "/repo/backend",
    "history": [
      "/repo/backend",
      "/repo/backend/services/api",
      "/repo/frontend"
    ]
  }
}
```

规则建议：

- 历史去重
- 保留最近 10 项
- 写入采用防抖

## 命令层建议

建议第一阶段扩展现有命令，而不是新增大量命令。

保守做法：

- `/pwd` 增强为显示当前目录和已绑定工作区
- `/cd -` 回到上一个目录
- `/cd` 无参数时显示当前目录和最近历史

可选第二阶段：

- `/workspace`
- `/workspace bind`
- `/workspace recent`

如果不新增 `/workspace` 命令，也至少要在 UI 文案里区分：

- 当前目录
- 当前工作区

## 与 session 的关系

工作区治理必须和 session 治理配合：

- 切换到新工作区时，是否关闭当前 `LiveSession`
- 当前 session 是否应该随 workspace 变化而失效
- reply-to-message 路由是否允许跨 workspace

建议第一阶段规则：

- 切换到不同仓库根目录时，关闭当前 chat 的相关 SDK session
- 切换到同一仓库的子目录时，可保守复用，也可统一重建

建议默认偏安全：

- 目录切换后重建会话，避免上下文漂移

## IM 交互变化

建议用户可见反馈更明确。

例如：

- `已切换目录：/repo/backend`
- `工作区：backend`
- `上一目录：/repo/frontend`

对于 `/sessions`：

- 应明确显示 session 所属目录
- 当前 session 是否属于当前工作区要一眼能看出来

## 风险与边界

风险：

- 如果工作区和目录概念混用，会让用户更困惑
- 目录切换触发 session 重建时，用户可能感知为“上下文丢失”

边界：

- 本篇不设计项目层配置
- 本篇不设计 webhook 路由
- 本篇不设计复杂 repo 生命周期管理

## 分阶段落地计划

### Phase 1

- 引入目录历史
- 支持 `/cd -`
- 增强 `/pwd`
- binding 中区分当前目录和工作区归属

### Phase 2

- 明确 workspace binding 持久化
- `/sessions` 和 Home 卡片显示工作区信息

### Phase 3

- 视多项目模型情况，打通 project 和 workspace 的关系

## 验收标准

- 用户能方便回到最近目录
- chat 和工作区的关系更清晰
- 目录切换后会话行为可预测
- IM 中能清楚看到当前目录和工作区状态

