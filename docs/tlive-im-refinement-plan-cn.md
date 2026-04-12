# tlive IM 能力细化拆文档计划

本文用于把现有 [cc-connect-comparison-cn.md](/home/glwuy/workspace/tlive/docs/cc-connect-comparison-cn.md) 中最重要的 1 到 4 四个方向继续细化，并拆成多个独立文档推进。

约束前提：

- `tlive` 保持 Claude-only
- 不以 Web 管理面为目标
- 主交互面仍然是 IM
- 文档重点放在可落地的产品能力和工程改造，而不是概念讨论

## 拆分目标

当前对比文档已经给出了高层结论，但 1 到 4 仍然偏“方向性判断”。

下一步需要拆成四篇独立文档，分别回答四类问题：

1. 这个方向为什么值得做
2. `tlive` 当前现状是什么
3. 目标能力边界是什么
4. 具体怎么改
5. 分几期落地
6. 哪些点明确不做

这样做的目的，是把“对比结论”转成“后续可执行设计输入”。

## 拆分范围

本轮只拆 1 到 4，暂不拆第 5 点“可扩展命令系统”。

对应四篇文档：

1. 多项目配置模型
2. 自动化入口：Webhook / Cron 边界
3. 工作区治理
4. 会话治理和多 session 体验

## 推荐文件命名

已新增以下四个文档：

- [docs/tlive-project-model-plan-cn.md](/home/glwuy/workspace/tlive/docs/tlive-project-model-plan-cn.md)
- [docs/tlive-automation-entry-plan-cn.md](/home/glwuy/workspace/tlive/docs/tlive-automation-entry-plan-cn.md)
- [docs/tlive-workspace-governance-plan-cn.md](/home/glwuy/workspace/tlive/docs/tlive-workspace-governance-plan-cn.md)
- [docs/tlive-session-governance-plan-cn.md](/home/glwuy/workspace/tlive/docs/tlive-session-governance-plan-cn.md)

本计划文档本身作为总索引：

- [docs/tlive-im-refinement-plan-cn.md](/home/glwuy/workspace/tlive/docs/tlive-im-refinement-plan-cn.md)

命名原则：

- 用 `tlive-...-plan-cn.md`
- 文件名直接表达主题
- 统一为中文规划文档，避免和现有安装文档混淆

## 每篇文档的统一结构

四篇文档建议统一使用下面的结构，降低阅读和维护成本：

1. 背景与问题
2. 当前 tlive 现状
3. 从 cc-connect 借鉴什么，不借鉴什么
4. 目标能力定义
5. 设计方案
6. 数据结构 / 配置 / 命令变更
7. IM 交互变化
8. 风险与边界
9. 分阶段落地计划
10. 验收标准

要求：

- 每篇都要明确“为什么不做 Web”
- 每篇都要写“保持 Claude-only 的影响”
- 每篇都要写“不做项”，防止范围膨胀

## 文档 1：多项目配置模型

目标文件：

- `docs/tlive-project-model-plan-cn.md`

核心目标：

- 从当前全局 `config.env` 模型，演进到 Claude-only 的多项目模型
- 让一个 `tlive` 进程能更清楚地表达“多个 repo / 多个默认目录 / 多组平台映射”

本篇要回答的问题：

- 当前单实例配置在什么场景下开始吃力
- 新的 `projects` 抽象最小需要包含哪些字段
- 项目和 chat、channel、cwd、settings scope 怎么关联
- 如何兼容现有 `config.env`
- 是否需要迁移脚本

建议重点章节：

- 现有配置痛点清单
- 目标配置示例
- 向后兼容策略
- 第一阶段只支持什么，不支持什么

本篇明确不展开的内容：

- Web 管理界面
- 多 Agent
- 复杂 RBAC

## 文档 2：自动化入口

目标文件：

- `docs/tlive-automation-entry-plan-cn.md`

核心目标：

- 只围绕 IM 场景，为 `tlive` 增加事件驱动入口
- 先做 webhook，后评估 cron

本篇要回答的问题：

- 为什么 webhook 比 cron 更适合 `tlive` 第一阶段
- webhook 应该支持哪些动作
- 如何定位目标 chat / session
- 是否允许 exec，还是只允许 prompt
- 安全边界怎么定
- 是否需要保留极薄的健康检查 / restart 接口

建议重点章节：

- 触发来源分类：git hook / CI / 手工 curl / 文件监听
- 请求模型设计
- session 路由策略
- 安全策略
- 与 hook-notification 的关系

本篇明确不展开的内容：

- 完整调度系统
- Web 控制台
- 通用开放平台协议

## 文档 3：工作区治理

目标文件：

- `docs/tlive-workspace-governance-plan-cn.md`

核心目标：

- 把 `cwd` 从“当前路径”升级成“可治理的工作区状态”
- 改善目录切换、项目识别、会话归属和长期使用体验

本篇要回答的问题：

- 当前 `/cd`、`/pwd`、`/sessions` 的边界在哪
- 为什么需要目录历史
- 是否要增加“最近目录”和“返回上一个目录”
- chat 和 workspace 的绑定如何持久化
- 是否需要“当前项目”概念

建议重点章节：

- 现有工作区模型
- 目录历史数据结构
- workspace 绑定模型
- 相关 IM 命令变化
- 兼容现有行为的方式

本篇明确不展开的内容：

- 自动 clone 仓库
- 真正的 multi-workspace 模式
- 跨平台同步 workspace

## 文档 4：会话治理和多 session 体验

目标文件：

- `docs/tlive-session-governance-plan-cn.md`

核心目标：

- 在保持 SDK 路线的前提下，把 `tlive` 的多 session 治理补强
- 提高忙时、恢复、切换、长期对话时的可靠性和可解释性

本篇要回答的问题：

- `tlive` 当前 session registry、bubble routing、active session 的行为是什么
- `cc-connect` 哪些多 session 策略值得借鉴
- 哪些策略不能直接照搬，因为 `tlive` 走 SDK
- busy queue 的上限和反馈应该怎么定义
- idle prune 和 idle auto-reset 的区别是什么
- resume mismatch recycle 和 fresh fallback 如何落地

建议重点章节：

- 当前 SDK 会话模型
- 典型故障场景
- 目标会话状态机
- queue / steer / reply-to-message 的统一规则
- 用户可感知的 IM 提示文案

本篇明确不展开的内容：

- 改走 CLI 驱动
- 多 Agent 混合会话
- 会话跨设备同步

## 依赖关系与写作顺序

建议写作顺序如下：

1. `tlive-session-governance-plan-cn.md`
2. `tlive-workspace-governance-plan-cn.md`
3. `tlive-project-model-plan-cn.md`
4. `tlive-automation-entry-plan-cn.md`

原因：

- 会话治理是最贴近当前 IM 体验、收益最高的部分
- 工作区治理和会话治理高度相关
- 多项目模型需要吸收前两篇对 session / workspace 的定义
- 自动化入口最后写，更容易基于前面确定的 session 和 project 路由模型收口

如果按实现优先级排，建议是：

1. 会话治理
2. 工作区治理
3. 自动化入口
4. 多项目模型

写作顺序和实现顺序可以不同，不强制绑定。

## 每篇文档的产出标准

每篇文档完成时，至少应满足：

- 有清晰的问题定义
- 有现状描述，不空谈未来
- 有明确边界和不做项
- 有可执行的分阶段计划
- 有至少一段配置或数据结构示例
- 有 IM 交互层面的影响说明

不满足以下情况：

- 只有概念，没有文件或模块影响分析
- 只有愿景，没有迁移路径
- 把 Web 方案混进 IM 主线
- 把多 Agent 作为默认前提

## 建议的下一步

建议下一篇先写：

- `docs/tlive-session-governance-plan-cn.md`

原因：

- 它最直接影响 IM 体验
- 它和 `cc-connect` 的差异最明确
- 它能为后续 workspace、project、webhook 路由提供稳定基础

完成这篇后，再继续写工作区治理文档。

## 当前实施进度（2026-04）

当前不是从零开始设计，而是已经完成了第一轮落地，形成了可运行但尚未完全收口的实现骨架。

按四条主线看，当前大致进度如下：

1. 会话治理：约 65%
   已有 queue / stale / idle reset / resume fallback / `/queue` / `/diagnose`
2. 工作区治理：约 65%
   已有目录历史、`/cd -`、增强 `/pwd`、workspace binding
3. 自动化入口：约 60%
   已有 webhook、最小 cron、project 路由、IM 内反馈
4. 多项目模型：约 60%
   已有 `projects.json`、`projectName` binding、`/project` 命令

当前阶段的主要问题不再是“有没有功能”，而是：

- 文档和实现的阶段描述还有偏差
- 四条治理链路之间的语义还不够一致
- 还有一些边界行为停留在“能用”，没有完全收口到“可预期”

## 下一阶段目标

下一阶段建议严格按下面顺序推进：

1. 先收口会话治理
   目标：用户在 busy / stale / resume 失败 / 切 session 时，不需要猜当前上下文
2. 再收口工作区治理
   目标：区分清楚“当前目录”和“长期工作区归属”，并统一切换语义
3. 再做多项目模型的减法和统一
   目标：项目层只承担默认 workdir、settings scope、自动化路由锚点
4. 最后稳定自动化入口
   目标：保留最小 webhook + prompt-only cron，不扩成管理平台

这也意味着：

- 不新增 Web 管理端
- 不把多人权限或平台运营面引入主线
- 不再把“抄 cc-connect 的功能面”当作目标，而是以“治理一致性”作为目标
