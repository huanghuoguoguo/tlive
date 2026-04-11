# cc-connect 对 tlive 的可借鉴点

本文只保留 `tlive` 真正值得从 `cc-connect` 借鉴的部分，不讨论明确不做的方向，也不展开 Web 管理面、多 Agent、多平台扩张等内容。

## 前提

本文默认以下前提成立：

- `tlive` 保持 Claude-only
- `tlive` 继续以 IM 作为主交互面
- `tlive` 不以 Web 管理面为目标
- 借鉴的是能力和治理思路，不是直接照搬 `cc-connect` 的整体产品形态

## 一个关键差异

`cc-connect` 和 `tlive` 对 Claude Code 的驱动方式不同：

- `tlive` 走 Claude Agent SDK / LiveSession
- `cc-connect` 直接驱动 `claude` CLI，通过 `stream-json + stdio` 协议通信

这个差异决定了：

- `tlive` 应该借鉴 `cc-connect` 的上层治理思路
- `tlive` 不应该照搬 `cc-connect` 的底层实现方式

## tlive 最值得借鉴的 4 个方向

### 1. 多项目配置模型

当前 `tlive` 更偏单实例、全局配置模式。这个模型在单用户、单仓库场景下足够简单，但在以下场景会开始吃力：

- 一个实例要服务多个仓库
- 不同 chat 需要稳定绑定不同项目
- 不同项目需要不同默认目录和 settings scope

`cc-connect` 的启发点在于：当 IM bridge 从“一个小工具”变成“长期运行的工作台”，项目层会自然出现。

`tlive` 值得借鉴的不是多 Agent 项目模型，而是 Claude-only 的轻量项目模型：

- 每个项目有唯一名称
- 每个项目有默认 `workdir`
- 每个项目可声明启用的 channels
- 每个项目可声明默认 `claudeSettingSources`
- chat 可以显式绑定到某个项目

这件事的价值在于：

- 为 workspace、session、automation 路由提供基础单位
- 降低“chat 当前到底在服务哪个 repo”的歧义
- 为后续 IM 内项目切换提供稳定语义

对应细化文档：

- [tlive-project-model-plan-cn.md](/home/glwuy/workspace/tlive/docs/tlive-project-model-plan-cn.md)

### 2. 自动化入口

`cc-connect` 的一个很实用的能力，是它不只是聊天驱动，还能被外部事件驱动。

对 `tlive` 来说，最值得借鉴的是：

- 增加一个受 token 保护的 webhook endpoint
- 支持把外部 prompt 投递到指定 chat 或 session
- 支持附加 event 名称和简单 payload
- 保持 IM 内可见反馈

最适合 `tlive` 的落地顺序是：

1. 先做 webhook
2. 再评估 cron

原因：

- webhook 更轻
- 与现有 hook 通知链路更接近
- 更适合 Git、CI、脚本集成
- 不需要先引入完整调度系统

这里借鉴的重点不是“做一套完整平台”，而是给 `tlive` 增加一个最小但可靠的事件入口。

对应细化文档：

- [tlive-automation-entry-plan-cn.md](/home/glwuy/workspace/tlive/docs/tlive-automation-entry-plan-cn.md)

### 3. 工作区治理

`tlive` 现在已经支持：

- `/cd`
- `/pwd`
- `/sessions`
- per-chat `cwd`

但当前模型仍然偏“当前路径”，还不算完整的工作区治理。

`cc-connect` 在这方面给出的启发主要有四点：

- 目录历史持久化
- 回到上一个目录
- 最近目录快速切换
- chat 和 workspace 的稳定绑定

对 `tlive` 来说，最值得做的不是一步到位上 multi-workspace，而是先补轻量能力：

- 每个 chat 保留目录历史
- 支持 `/cd -`
- 增强 `/pwd` 展示
- 明确区分“当前目录”和“当前工作区”
- 给 chat 建立更稳定的 repo 归属

这部分做完以后，用户长期在 IM 中切目录、切仓库、切 session 的体验会稳定很多。

对应细化文档：

- [tlive-workspace-governance-plan-cn.md](/home/glwuy/workspace/tlive/docs/tlive-workspace-governance-plan-cn.md)

### 4. 会话治理和多 Session 体验

这是 `cc-connect` 最值得 `tlive` 借鉴的一块。

`tlive` 当前在多 session 上已经有不错的基础：

- 可以切历史会话
- 可以通过 reply-to-message 精确命中某条 session
- 可以用 SDK 的 `now` / `later` 做 steer / queue

但它目前更偏“会话路由器”，而 `cc-connect` 更像“会话治理器”。

`cc-connect` 最值得借鉴的策略有：

- busy session 的明确排队语义
- 当前 turn 结束后自动续跑下一条排队消息
- resume 失败时自动 fresh fallback
- session 与底层上下文错配时主动回收
- 长时间空闲后自动 reset 会话

这些能力对 `tlive` 的价值很高，因为它们直接影响 IM 使用体验：

- 用户继续追问时系统如何处理
- 用户切 session 后是否会串上下文
- 长时间不用再回来时是否还在旧上下文里
- 恢复失败时是否能自动兜底

`tlive` 在这部分最适合的借鉴方式是：

- 保留 SDK 架构
- 强化会话生命周期治理
- 把治理结果清楚地反馈到 IM 中

对应细化文档：

- [tlive-session-governance-plan-cn.md](/home/glwuy/workspace/tlive/docs/tlive-session-governance-plan-cn.md)

## 推荐优先级

如果按收益和与 IM 主线的贴合度排序，建议优先级如下：

1. 会话治理和多 session 体验
2. 工作区治理
3. 自动化入口
4. 多项目配置模型

如果按“基础设施依赖”排序，建议是：

1. 会话治理
2. 工作区治理
3. 多项目配置模型
4. 自动化入口

两种排序都成立，区别只在于是先追求 IM 体验，还是先补底层表达能力。

## 一句话结论

`tlive` 从 `cc-connect` 最值得借鉴的，不是功能列表更大，而是这四件事：

- 项目层
- 事件入口
- 工作区治理
- 会话治理

这四件事都可以在保持 Claude-only、IM-first 的前提下推进，而且会直接改善 `tlive` 的长期使用体验。
