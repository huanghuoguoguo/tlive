# tlive 项目目录与 Skills 默认加载方案

## 背景

当前 `tlive` 在 IM 中已经支持两类 `/xxx`：

- `tlive` 自己实现的桥接命令，例如 `/new`、`/sessions`、`/cd`、`/help`
- 透传给 Claude Code 的 slash 命令或 skill 调用

现有实现里，未知的 `/xxx` 不会被桥接层吞掉，而是继续透传给 Claude Code。这意味着从协议能力上看，`tlive` 已经具备显式 `/xxx` 调用的基础。

问题在于，Claude Code 侧是否真的能识别这些 `/xxx`，取决于当前会话有没有加载 project 级设置与 skills。

## 当前行为

### 1. `/cd` 会修改工作目录

`/cd` 会把 chat binding 中的 `cwd` 更新为新的目录。后续 turn 会读取这个 `cwd`，并将其作为 `workingDirectory` 传给 Claude SDK。

这说明“进入工作目录”这件事本身已经成立。

### 2. 进入工作目录不等于加载该目录的 project settings

当前 `workingDirectory` 与 `settingSources` 是两套独立机制：

- `workingDirectory` 决定 Claude 在哪个目录执行
- `settingSources` 决定 Claude 是否加载 `~/.claude/settings.json`、项目内 `.claude/settings.json`、`CLAUDE.md`、MCP、skills

目前配置默认值仍然是 `user`，即只加载全局认证和模型配置，不默认加载项目级 skills。

这会带来一个语义落差：

- 用户视角：`/cd repo-a` 就是在切到 repo-a 工作
- 当前实现：Claude 的执行目录切到 repo-a 了，但 repo-a 下的 rules / MCP / skills 可能并没有一起生效

### 3. slash command 透传能力已经存在

桥接层只拦截自己认识的命令。未识别的 `/xxx` 会继续透传给 Claude Code。

因此，问题不在 “`tlive` 能不能透传 `/xxx`”，而在 “透传后 Claude 当前会话有没有加载到对应 skill”。

### 4. 现有文档存在默认值不一致

仓库里已经出现了两个口径：

- `config.env.example` 推荐 `TL_CLAUDE_SETTINGS=user,project,local`
- `docs/configuration*.md` 仍写着 `TL_CLAUDE_SETTINGS=user`

这会放大用户困惑，因为示例配置与文档说明表达了不同的默认预期。

## 目标语义

建议将产品语义统一为以下规则：

### 1. “进入工作目录”默认意味着“进入该项目上下文”

只要一个 chat 的当前工作目录指向某个仓库或项目目录，Claude 就应默认加载该目录下的 project settings。

这里的“项目上下文”至少包括：

- `.claude/settings.json`
- `CLAUDE.md`
- MCP 配置
- skills
- `.claude/settings.local.json`

### 2. 默认 settings source 改为 `user,project,local`

推荐把默认值从 `user` 调整为 `user,project,local`，使默认行为符合用户直觉。

这样用户不需要额外记住：

- 进入目录后还要再执行 `/settings full`
- skill 失效时要先判断是不是 settings source 没开

### 3. `/settings` 仍然保留显式覆盖能力

默认改为 full 不意味着移除控制项。

以下显式行为仍然保留：

- `/settings user`：只加载全局配置
- `/settings full`：加载全量 project context
- `/settings isolated`：完全隔离

也就是说，默认值应该更符合多数用户预期，但仍允许高级用户显式降级。

## 预期用户体验

统一后的语义应当是：

1. 用户通过默认目录进入项目，或用 `/cd` 切换到项目目录
2. 后续消息默认在该目录执行
3. 该目录下的 `CLAUDE.md`、MCP、skills 自动生效
4. 用户发送未知的 `/xxx` 时，`tlive` 继续透传给 Claude
5. 如果对应 skill 存在，Claude 直接执行；如果不存在，再由 Claude 自己报错或回退

这样“切目录”和“切项目上下文”就不再是两件互相割裂的事情。

## 实现建议

### 1. 统一默认值

优先修改以下默认值来源，避免出现运行时与配置文档不一致：

- `src/config.ts` 中 `TL_CLAUDE_SETTINGS` 的默认值
- `src/providers/claude-sdk.ts` 中 provider 构造器的兜底默认值

目标默认值：

```env
TL_CLAUDE_SETTINGS=user,project,local
```

### 2. 统一文档口径

需要同步更新：

- `docs/configuration.md`
- `docs/configuration-cn.md`
- `README.md`
- `README_CN.md`

文档需要明确说明：

- `/cd` 会切换工作目录
- 在默认配置下，切换到项目目录后会自动加载该项目的 rules / MCP / skills
- 如需禁用，可使用 `/settings user` 或 `/settings isolated`

### 3. 保持会话级 workdir 语义

当前 LiveSession 已经按 `channelType:chatId:workdir` 建 session key。这个方向是对的，应继续保持。

这意味着：

- 同一个 chat 切到新目录时，会自然进入新的 session bucket
- 旧目录 session 可保留，避免强制销毁历史上下文

后续若发现用户对“切目录后继续 steer 到旧会话”存在困惑，再评估是否在 `/cd` 时主动关闭该 chat 的 active session。

### 4. 补测试

建议补以下回归测试：

- 默认配置下，provider 会加载 `user,project,local`
- `/cd` 后新 turn 使用新的 `workingDirectory`
- 未识别的 `/xxx` 会透传，不被桥接层吞掉
- `/settings user|full|isolated` 能覆盖默认值

## 风险与兼容性

### 1. 默认变更可能影响“隔离型”用户

少数用户可能刻意依赖当前 `user` 默认值，避免项目内规则影响通用对话。

这个风险可以接受，因为：

- 仍保留 `TL_CLAUDE_SETTINGS=user`
- 仍保留 `/settings user`
- 仍保留 `/settings isolated`

### 2. 项目内错误配置会更容易暴露

一旦默认启用 project settings，项目里的无效 MCP、损坏的 skills、错误的 `CLAUDE.md` 会更早暴露。

但这其实更符合“在项目中工作就应加载项目配置”的原则，属于把行为改得更真实，而不是引入新问题。

## 结论

这个问题的本质不是 `/cd` 没有进入工作目录，而是“进入工作目录”和“加载项目上下文”在当前实现里被拆开了。

建议将 `tlive` 的默认语义调整为：

- 默认 `TL_CLAUDE_SETTINGS=user,project,local`
- `/cd` 不只是切执行目录，也默认切入该目录对应的 project context
- 未识别的 `/xxx` 继续透传给 Claude，让 skill 显式调用真正可用

这个语义一旦确定，后续实现和文档都应围绕它保持一致。
