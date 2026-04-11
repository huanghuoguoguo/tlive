# tlive 多项目配置模型规划

本文聚焦 `tlive` 的多项目配置模型演进，目标是在保持 Claude-only 和 IM-first 的前提下，让一个 `tlive` 进程能更自然地表达多个 repo、多个默认目录和多组平台映射。

## 背景与问题

当前 `tlive` 采用全局 `config.env` 配置模型，适合：

- 单用户
- 单项目
- 少量 IM 平台
- 默认目录长期不变

当使用场景变成下面这些情况时，现有模型开始吃力：

- 一个 bridge 需要管理多个代码仓库
- 不同 chat 需要稳定绑定不同项目
- 不同项目需要不同默认目录或 Claude settings scope
- 同一套运行实例需要表达更明确的“项目”概念

`cc-connect` 的 `[[projects]]` 模型说明：一旦 bridge 从“单点工具”演化成“长期运行的 IM 工作台”，项目层就会自然出现。

## 当前 tlive 现状

当前 `tlive` 的配置特点：

- 只有一份全局配置
- `defaultWorkdir` 是全局级别
- IM 平台启用状态是全局级别
- chat 通过 binding 记录 `cwd`、`sessionId`、`sdkSessionId`
- 还没有正式的 `project` 抽象

这套模型的优点：

- 简单
- 易安装
- 运行路径短

这套模型的限制：

- chat 和 repo 的关系是运行时推导出来的，不是显式配置
- 缺少“项目默认行为”这一层
- 未来若接入 webhook 或更多自动化入口，路由基础不够清晰

## 从 cc-connect 借鉴什么，不借鉴什么

借鉴：

- 明确引入项目层
- 每个项目独立定义默认目录和策略
- 让项目成为后续 session、workspace、automation 路由的基础单位

不借鉴：

- 多 Agent 抽象
- 大而全的平台组合矩阵
- 复杂的 project-level Web 管理能力

结论：

- `tlive` 只需要一个 Claude-only 的轻量项目模型

## 目标能力定义

第一阶段目标能力：

- 支持多个项目定义
- 每个项目有唯一 `name`
- 每个项目有 `workdir`
- 每个项目可声明启用的 channels
- 每个项目可声明默认 `claudeSettingSources`
- chat 可以绑定到某个项目

第一阶段不做：

- 多 Agent
- 项目级 RBAC
- 项目级 webhook UI
- 自动 clone / 自动发现项目

## 配置模型建议

建议在保留当前 `config.env` 兼容能力的前提下，引入新的结构化配置层。可以是：

- 新增 `projects.json`
- 或新增 `config.json`
- 或逐步从 `config.env` 迁移到更结构化格式

建议最小字段：

```json
{
  "defaultProject": "main",
  "projects": [
    {
      "name": "main",
      "workdir": "/path/to/repo",
      "channels": ["telegram", "feishu"],
      "claudeSettingSources": ["user", "project", "local"]
    }
  ]
}
```

如果短期必须兼容 `config.env`，建议采用：

- 旧配置仍然可用
- 没有 `projects` 时，自动生成一个隐式默认项目
- 只有启用多项目后，才要求结构化配置

## 运行时模型建议

建议引入以下概念：

- `ProjectConfig`
- `ProjectBinding`
- `ChatProjectSelection`

建议运行时规则：

- 每个 chat 总是有一个当前项目
- 每个项目有自己的默认目录
- chat 如果未显式绑定项目，则落到默认项目
- 切换项目时，可选择是否同时切换 cwd 和 session

建议 chat binding 增加字段：

- `projectName`
- `projectWorkdirSnapshot`

这样可以避免仅凭 `cwd` 反推项目。

## 与现有命令的关系

需要明确哪些命令会受到项目模型影响：

- `/new`
- `/sessions`
- `/session`
- `/cd`
- `/pwd`
- `/settings`

建议新增但不一定第一期实现的命令：

- `/project`
- `/project list`
- `/project use <name>`

如果第一期不做新命令，至少要在：

- Home 卡片
- Status 卡片
- Session 切换反馈

里显示“当前项目”。

## 迁移策略

建议分两步迁移：

### 第一步

- 保持 `config.env`
- 在内存中构造一个隐式默认项目
- 不改变现有安装路径

### 第二步

- 增加结构化项目配置文件
- 新装用户走新配置
- 老用户继续兼容旧配置

## 风险与边界

风险：

- 过早把项目模型做重，会让安装和调试复杂化
- 如果项目和 cwd 的关系定义不清，用户会困惑
- 若命令层面没有足够提示，项目切换会造成“上下文错位”感

边界：

- 只解决“项目表达能力”
- 不在本篇里解决 webhook 路由细节
- 不在本篇里解决 session 队列细节

## 分阶段落地计划

### Phase 1

- 设计 `ProjectConfig` 数据结构
- 在运行时引入隐式默认项目
- binding 增加 `projectName`
- 在 IM 状态里展示当前项目

### Phase 2

- 增加结构化配置文件
- 支持多个项目
- 支持 chat 显式切换项目

### Phase 3

- 为 webhook / automation 提供基于项目的路由基础

## 验收标准

满足以下条件时，可认为本项完成：

- `tlive` 可以明确表达多个项目
- chat 到项目的绑定是显式的
- 现有单项目用户无需迁移也能继续使用
- 切换项目后，IM 中能看见清晰反馈
- 后续 workspace / session / webhook 文档可以基于该项目层继续设计

