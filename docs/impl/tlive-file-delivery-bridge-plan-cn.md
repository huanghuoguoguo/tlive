# tlive 本地文件主动发送能力现状与桥接方案

本文说明 `tlive` 当前是否具备“把本地文件主动发送给当前用户”的能力，并给出适合 Claude Code SDK 场景的桥接设计。

## 一句话结论

当前 `tlive` **没有现成可用的端到端能力**，可以让 agent 在本地生成文件后，主动把该文件发送到当前 IM 会话。

更准确地说：

- Claude Code 本身可以在工作区内读写文件。
- `tlive` 的 Telegram / 飞书适配器底层已经有“发送媒体/文件”的代码路径。
- 但 `tlive` 目前没有一个上层入口，把“本地文件路径”读取出来，再路由到当前 chat，并调用对应 adapter 发出去。
- Claude Code 当前也不知道“当前 chat 支持什么发送能力、应该调用什么桥梁、发送给谁”。

所以今天的真实状态是：**有部分底层发送积木，但没有完整的文件投递桥梁。**

## 当前代码现状

### 1. 出站媒体类型已经存在

`tlive` 已定义出站媒体结构 `MediaAttachment`，支持：

- `buffer`
- `url`
- `data URI`

对应代码：

- `src/channels/types.ts`

这说明“发送文件”在抽象层面已经被考虑过，但还不是一个完整功能。

### 2. Telegram / 飞书已有底层发送实现

当前：

- Telegram adapter 收到 `message.media` 时，会调用 `sendPhoto` 或 `sendDocument`
- 飞书 adapter 收到 `message.media` 时，会先上传，再发送 `image` / `file`

对应代码：

- `src/platforms/telegram/adapter.ts`
- `src/platforms/feishu/adapter.ts`

这部分说明：如果桥接层能构造好 `message.media`，Telegram 和飞书理论上已经可以发文件。

### 3. QQ Bot 还没有出站文件发送链路

QQ Bot 当前 `send()` 只处理 markdown 文本，没有处理 `message.media`。

对应代码：

- `src/platforms/qqbot/adapter.ts`

因此 QQ Bot 目前不具备同等级基础能力。

### 4. 上层入口仍然是 text-only

当前以下路径都只发文本，不接受“本地文件路径”：

- `BridgeManager.injectAutomationPrompt()` 只接收 `text`
- `WebhookServer` 反馈只发文本
- `CronScheduler` 反馈只发文本
- 常规 query 执行结果最终也只是文本/card

对应代码：

- `src/engine/bridge-manager.ts`
- `src/engine/webhook-server.ts`
- `src/engine/cron-scheduler.ts`

这意味着现有系统里没有一个“把本地文件读出来然后发给当前 chat”的正式入口。

## 需要澄清的地方

“读文件能力”要分成两层看：

### 1. Claude Code 的读文件能力

这个是有的。

Claude Code 在工作区内本来就可以通过自身工具读取文件、生成图片、写 PPT、写 HTML、写 PDF。

### 2. tlive 桥的“读取本地产物并发送给 IM”的能力

这个目前没有。

也就是说，agent 可以在磁盘上生成：

- `dist/report.pdf`
- `output/diagram.png`
- `slides/demo.pptx`

但生成之后，`tlive` 现在不会自动知道：

- 哪个文件是要发给用户的最终产物
- 应该发给哪个 chat
- 当前 channel 是否支持发这个文件
- 是发 image 还是 file
- 发送是否需要用户确认

因此，如果你问“当前有没有把本地文件读出来并主动发给用户的能力”，答案是：**没有完整能力。**

## 为什么 Claude Code SDK 场景下天然缺这座桥

现在 `tlive` 是通过 Claude Code SDK 驱动 CC。

这会带来一个关键问题：**Claude Code 运行在工作目录/工具上下文里，但 IM 发送能力存在于 `tlive` bridge 进程里。**

两边天然不是同一个抽象层。

Claude Code 默认并不知道这些运行时信息：

- 当前消息来自哪个 channel
- 当前目标 chatId 是什么
- 当前 channel 是否支持图片发送
- 当前 channel 是否支持文件发送
- 应该通过哪个函数或工具触发发送

所以即使 agent 成功生成了 `foo.png`，它也不知道后续应该怎么把它送到当前用户手里。

## 仅做 skill 不够

可以做 skill，但 **skill 只能教 agent“应该怎么想”，不能单独提供真正的发送执行能力**。

单独做一个 skill 的问题：

- skill 可以告诉 agent “生成图片后尝试发送给用户”
- 但 skill 不知道当前 chat / channel 的实时上下文
- skill 也没有天然的执行句柄把文件发到 IM
- skill 无法可靠校验当前 channel 能否发送该文件
- skill 无法自己完成权限审批、审计、失败回退

所以：

- **只有 skill，没有桥接工具**，不够。
- **只有桥接工具，没有提示 agent 何时调用**，体验也不好。

合理方案是：

- 用 runtime bridge 提供真实发送能力
- 用 prompt/runtime context 告诉 agent 当前能力边界
- 用 skill 作为补充，教 agent 何时调用发送工具、如何挑选产物

## 推荐方案

推荐采用三层设计：

1. `tlive` bridge 提供正式的“发送本地产物到当前 chat”能力
2. 每轮 query 向 Claude Code 注入当前 chat 的发送能力上下文
3. 可选增加 skill，教 agent 在生成图片/PPT/PDF 后主动调用发送能力

其中第 1 层是必须的，第 2 层强烈建议，第 3 层是加分项。

## 产品目标与用户体验原则

这个能力的产品目标不是“新增一个发送文件 API”，而是：

- 让用户在 IM 里发起任务后，能自然收到最终产物
- 减少用户追加一句“发我”“文件在哪”的次数
- 让 agent 从“会生成文件”升级为“会交付结果”

建议遵守以下体验原则：

### 1. 默认交付，不默认打扰

当系统对“哪个文件是最终结果”有较高把握时，应自动发送，而不是停在本地路径。

只有在结果不明确、风险较高或 channel 不支持时，才提示用户确认。

### 2. 始终面向当前 chat

第一阶段只处理“发送到当前会话”。

不要让用户额外理解：

- 发到哪个 chat
- 发给谁
- 选择哪个 channel

这类复杂性应由 bridge 在运行时解决。

### 3. 以“最终产物”为中心，不以文件系统为中心

用户要的是：

- 图
- PPT
- 报告
- 表格

而不是：

- 某个输出目录
- 若干中间文件
- 一堆源码和临时文件

因此产品上应该显式建立“产物”概念，而不是把所有文件一视同仁。

### 4. 自动化要可见、可解释、可重试

发送成功后，系统应给出明确回执。

发送失败后，系统应说明：

- 为什么没发出去
- 是否自动降级成了别的发送方式
- 用户下一步可以怎么做

### 5. 把 skill 当成行为提示层，而不是核心能力层

最终体验不应依赖“用户知道某个 skill 名字”。

用户只需要自然地下任务，系统应完成能力发现、产物识别和发送。

## 目标用户场景

优先覆盖以下高频场景：

### 场景 1：出图

用户说：

- “画一个系统架构图”
- “出一张海报”
- “把这个流程做成图”

期望体验：

- agent 生成 PNG/JPG/SVG 对应的最终预览产物
- `tlive` 优先把图片直接发到当前 chat
- 文本只做简短说明，不要求用户再去本地路径找图

### 场景 2：做 PPT

用户说：

- “帮我做一个 8 页汇报 PPT”

期望体验：

- agent 生成 `.pptx`
- `tlive` 自动把 `.pptx` 作为附件发到当前 chat
- 如有可选 PDF 导出，可在文本中提示“需要的话我也可以导出 PDF 版”

### 场景 3：生成报告/文档

用户说：

- “写一个调研报告”
- “导出成 PDF”
- “整理成 Word 文档”

期望体验：

- 对 `pdf/docx/html` 这类用户可直接消费的文件执行交付
- 不把源 markdown、构建脚本、中间 JSON 当成默认交付物

### 场景 4：导出表格

用户说：

- “整理成 Excel 发我”

期望体验：

- 自动发送 `.xlsx`
- 如果同时生成了 `.csv` 和 `.xlsx`，优先发 `.xlsx`

## 用户旅程

建议把整体流程定义为 5 个阶段：

### 1. 用户下达任务

用户只用自然语言表达结果诉求，例如：

- “做一个 PPT 发我”
- “出图”
- “生成 PDF”

这里不要求用户声明技术细节。

### 2. agent 生成候选产物

任务执行期间，系统记录本轮新增/修改的文件，并标记其中可能的候选产物。

### 3. bridge 判定最终交付物

query 即将结束时，bridge 基于规则判断：

- 是否存在明显最终产物
- 当前 channel 是否支持发送
- 是否应自动发送
- 是否需要用户确认

### 4. 系统执行发送

bridge 调用正式发送链路，把产物投递到当前 chat。

### 5. 系统给出回执

理想回执示例：

- “已生成并发送架构图”
- “已发送 PPT：`weekly-review.pptx`”
- “已发送 PDF 报告：`benchmark-report.pdf`”

如果失败，应返回类似：

- “已生成 `weekly-review.pptx`，但当前 channel 不支持文件发送”
- “文件超过大小限制，未自动发送”

## 核心产品概念：Task Output

建议把“产物”作为正式模型引入，而不是临时启发式。

可定义为：

```ts
interface TaskOutputCandidate {
  path: string;
  mimeType: string;
  sizeBytes: number;
  createdThisTurn: boolean;
  modifiedThisTurn: boolean;
  category: 'image' | 'presentation' | 'document' | 'spreadsheet' | 'web' | 'archive' | 'other';
  score: number;
  reasonTags: string[];
}
```

其中 `score` 可由以下因素组成：

- 是否本轮新生成
- 是否在 `output/`、`dist/`、`artifacts/` 等产物目录
- 文件扩展名是否属于用户可消费格式
- 文件名是否包含 `final`、`report`、`slides`、`diagram` 等信号
- 是否为用户在任务中明确要求的格式

bridge 最终从候选集合中挑选 0 个、1 个或多个“最终交付物”。

## 自动发送判定规则

建议采用“自动发送 / 轻确认 / 不发送”三级模型。

### 自动发送

满足以下条件时自动发送：

- 当前任务目标明确要求产物
- 只有 1 个高置信候选产物
- 文件位于安全目录内
- 目标就是当前 chat
- 当前 channel 支持该类型
- 文件大小在限制内

典型例子：

- 生成了唯一一个 `artifacts/demo.png`
- 生成了唯一一个 `slides/weekly-review.pptx`
- 生成了唯一一个 `output/report.pdf`

### 轻确认

满足以下任一条件时，建议先确认：

- 有多个高置信候选产物
- 生成了多种格式，但用户未明确偏好
- 文件较大但仍可发送
- 文件在非标准产物目录
- 用户目标是“挑一个版本”

建议确认文案尽量轻量，例如：

- “检测到 2 个候选产物，准备发送 `demo.pptx`。回复‘发送全部’可一并发送。”
- “检测到 PNG 和 SVG 两个版本，默认发送 PNG。需要 SVG 的话告诉我。”

### 不发送

满足以下任一条件时默认不发送：

- 只有源码、脚本、日志、缓存、临时文件
- 文件位于敏感路径
- 文件类型不在允许名单中
- 文件过大
- 当前 channel 不支持

此时应返回解释，而不是静默略过。

## 文件选择优先级

当存在多个候选产物时，建议按以下优先级选择默认交付物：

1. 用户明确指定的格式
2. 当前 channel 最适合展示的格式
3. 最终消费格式优先于中间格式
4. 可直接预览的格式优先于不可预览的格式
5. 文件名更像“最终结果”的产物优先

建议的默认偏好示例：

- 图像任务：`png` > `jpg` > `svg` > 源工程文件
- PPT 任务：`pptx` > `pdf` > markdown 源稿
- 文档任务：`pdf` / `docx` > markdown
- 表格任务：`xlsx` > `csv`

## 交互文案建议

### 自动发送成功

- “已生成并发送架构图。”
- “已发送 PPT：`weekly-review.pptx`。”
- “已发送 PDF 报告：`benchmark-report.pdf`。”

### 自动降级成功

例如图片无法以内联方式发送但可以作为文件发送：

- “图片已生成，已改为文件附件发送。”

### 需要确认

- “检测到 3 个候选产物，默认准备发送 `final-report.pdf`。如需全部发送，请回复‘发送全部’。”

### 无法发送

- “已生成 `demo.pptx`，但当前 channel 暂不支持文件发送。”
- “已生成产物，但文件超过大小限制，未自动发送。”
- “检测到的文件位于敏感路径，未自动发送。”

### 用户主动重发

后续可支持：

- “重发刚才那个文件”
- “把 PDF 版也发我”
- “不要发成品，把源码发我”

## MVP 范围建议

为避免一次做得过重，建议首版严格收敛。

### 支持的目标 channel

- Telegram
- 飞书

QQ Bot 暂不纳入 MVP。

### 支持自动交付的文件类型

- 图片：`png`、`jpg`、`jpeg`, `gif`
- 文档：`pdf`、`docx`
- 演示文稿：`pptx`
- 表格：`xlsx`
- 网页产物：`html`（可作为文件发）

### 自动发送条件

仅在以下情况下自动发送：

- 单一明显最终产物
- 位于安全目录
- 发送目标为当前 chat
- 文件大小合规

其余情况进入轻确认或仅文本提示。

### MVP 暂不做

- 发送到非当前 chat
- 批量复杂多文件投递
- 跨 channel 转发
- 超大文件自动压缩
- 多轮产物历史管理界面

## 成功指标

建议至少跟踪以下指标：

- 产物型任务中，无需用户追加“发我”的比例
- 自动发送成功率
- 自动发送失败率
- 自动发送后用户二次要求“发别的文件”的比例
- 轻确认触发率
- 自动发送误判率
- 各 channel 的失败原因分布

如果后续要做体验迭代，这些指标很重要。

## 为什么这比“本地路径提示”体验更好

现在很多 agent 系统的停留点是：

- “文件已生成：`output/report.pdf`”

这其实仍然是开发者心智，不是用户心智。

用户真正要的是：

- “把结果交给我”

因此从产品上，最佳体验不是“告诉用户文件在哪”，而是“把结果交付到用户手边”。

## 方案细化

### 方案 A：只靠最终文本约定解析

例如要求 agent 在最终回复里输出：

```text
SEND_FILE: output/demo.png
```

然后 `tlive` 解析这段文本，再去发送文件。

优点：

- 实现快
- 不需要额外 MCP/tool

缺点：

- 非常脆弱
- 容易被自然语言误触发
- 多文件发送、caption、类型判断都不稳
- 无法优雅做权限控制
- 很难扩展成长期能力

这个方案只适合做非常短期的 PoC，不适合正式设计。

### 方案 B：只做 skill

优点：

- 改动小
- 可快速提示 agent 行为

缺点：

- 没有真实执行通道
- 无法承载 runtime chat 上下文
- 不解决权限和路由问题

因此不能单独采用。

### 方案 C：增加正式发送工具/桥梁

这是推荐方案。

核心思路：

- `tlive` 暴露一个 bridge 内部能力，例如 `sendLocalArtifact()`
- agent 通过一个明确工具调用该能力
- bridge 读取本地文件，判定 channel 能力，完成发送

这条路才是真正稳定的“产物交付链路”。

## 推荐的能力模型

建议新增一个桥接服务层，例如：

- `ArtifactDeliveryService`

建议职责：

- 校验文件路径
- 读取本地文件
- 判断 MIME type
- 选择 `image` 或 `file`
- 根据 channel 调用 adapter 发送
- 记录发送日志和失败原因

建议 bridge 侧 API 类似：

```ts
sendLocalArtifact({
  channelType,
  chatId,
  filePath,
  caption,
  forceType, // 'image' | 'file'
});
```

### 路径安全建议

必须限制边界，避免 agent 把任意敏感文件发出去。

建议默认规则：

- 仅允许发送当前工作目录下的文件
- 或仅允许发送显式产物目录，如 `dist/`、`output/`、`artifacts/`
- 拒绝发送 `~/.ssh`、`~/.config`、`~/.tlive`、环境文件等敏感路径
- 超大文件直接拒绝或提示压缩

### Channel 能力建议

建议新增 adapter 能力声明，而不是靠调用时猜：

```ts
interface OutboundCapability {
  canSendImage: boolean;
  canSendFile: boolean;
  maxFileBytes?: number;
}
```

当前预期矩阵：

- Telegram：`image + file`
- 飞书：`image + file`
- QQ Bot：先实现为 `none` 或仅 `image`，视接口能力补齐

## Claude Code 如何知道这能力存在

这里不能只靠 skill，应该同时做 **runtime context 注入**。

建议在每轮 prompt 前注入类似上下文：

```text
[tlive runtime]
Current delivery target: telegram chat 123456
Outbound delivery supported: image,file
If you generate a user-facing artifact (png/pdf/pptx/html/docx/xlsx),
use the delivery tool to send it to the current chat.
Prefer sending final artifacts rather than raw source files.
```

这类上下文应由 `tlive` 在 query 开始时动态拼接，因为它依赖实时 chat 信息，skill 本身拿不到。

## 工具形态建议

最理想的形态是一个明确工具，而不是文本约定。

可选形式：

- bridge 内建工具
- 本地 MCP server 暴露的工具
- SDK 支持的其他可调用工具通道

推荐语义：

```ts
deliver_artifact({
  path: "output/demo.png",
  title: "架构图",
  caption: "这是生成的架构图",
  audience: "current_chat"
})
```

bridge 收到后执行：

1. 解析为绝对路径
2. 做安全校验
3. 检查当前 channel 能力
4. 自动识别 MIME
5. 调用 adapter 发送
6. 返回发送结果给 agent

返回结果建议包含：

- `success`
- `messageId`
- `deliveredAs` (`image` / `file`)
- `reason`（失败时）

## 是否应该做成 skill

结论：**可以做，但必须是“工具之上的行为指导层”，不是底层能力本身。**

推荐定位：

- skill 负责教 agent：
  - 什么情况下应该把产物发给用户
  - 优先发送哪些文件
  - 如何给文件命名
  - 多个候选文件时如何选择最适合交付的那个
- bridge/tool 负责真正执行发送

例如 skill 可以约束：

- 当任务目标是“出图”“做 PPT”“生成报告”“导出表格”时，如果生成了用户可直接消费的产物，应调用 `deliver_artifact`
- 优先发送最终产物，而不是中间源码
- 同时在文本里给出一句简短说明

但没有 `deliver_artifact` 之前，skill 只会停留在“知道该做什么”，做不到“真的发出去”。

## 推荐落地方向

### Phase 1：补齐 bridge 内部文件发送能力

新增：

- `ArtifactDeliveryService`
- `BridgeManager.sendLocalArtifact()`

先支持：

- Telegram
- 飞书

QQ Bot 暂时返回不支持。

### Phase 2：把运行时能力注入给 Claude Code

在 query 开始时，把当前 chat 能力、可发送类型、发送规则注入 prompt/runtime context。

目标是让 agent 明确知道：

- 当前可不可以发
- 可以发什么
- 应该把文件发给谁

### Phase 3：暴露正式工具

推荐增加一个明确工具：

- `deliver_artifact`

这是从“agent 能感知能力”走向“agent 能完成交付”的关键一步。

### Phase 4：补一个配套 skill

等工具稳定后，再增加一个 skill 或文档约定，专门优化产物交付体验。

这时 skill 才真正有意义。

## 与现有权限体系的关系

发送文件本质上是一次对外投递，风险不低。

建议纳入权限体系：

- 默认允许发送到当前 chat
- 若路径超出工作区，要求审批
- 若目标不是当前 chat，要求审批
- 若文件类型或大小异常，要求审批

这样才能和现有 `canUseTool` / IM 审批模型保持一致。

## 建议的最终判断

如果目标是让 agent 在以下场景里自动把产物交付给用户：

- 生成图片后直接发图
- 生成 PPT 后直接发 `.pptx`
- 生成 PDF 报告后直接发文件
- 生成 Excel/Word 后直接发附件

那么正确路线不是“只做一个 skill”，而是：

1. 先补 `tlive` 的文件投递桥梁
2. 再把当前 chat 的发送能力注入给 Claude Code
3. 再增加 `deliver_artifact` 之类的正式工具
4. 最后用 skill 优化 agent 的交付习惯

简化成一句话：

**skill 负责让 agent 知道“该发”，tool/bridge 负责让 agent 真的“能发”。**

## 当前结论摘要

截至当前代码状态：

- Claude Code 能在本地生成和读取文件
- `tlive` 没有现成的“读取本地产物并主动发送给当前用户”的完整能力
- Telegram / 飞书已有底层媒体发送积木
- QQ Bot 还没有相应出站文件能力
- 单靠 skill 不足以建立这座桥
- 推荐建设正式的 artifact delivery bridge，并把它暴露给当前 query
