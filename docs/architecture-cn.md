# Server / Client 架构

TLive 现在按三块代码组织：

- `src/server/`：控制面。负责 IM 适配、飞书/Lark 话题、工作台卡片、命令路由、client 注册表、权限，以及向节点下发控制消息。
- `src/client/`：执行面。负责连接 server，上报本机 provider、workspace 和 SDK 会话，并真正执行 Claude Code / Codex turn。
- `src/shared/`：两端共享且不依赖 server/client 的协议和工具，包括 protocol messages、provider capability 类型、formatting 类型、i18n 和 core helpers。

状态所有权也按这个边界划分：

- server 可以持久化 IM 路由状态，例如 chat binding 和 topic mapping。
- client 拥有 SDK runtime 状态和会话发现能力，并通过 remote protocol 把 session descriptor 上报给 server。
- 工作台只是汇总视图，不应该扫描 server 本机 Claude/Codex history 作为全局事实源。

CLI 默认会同时启动 server 和一个 `local` 执行 client。这个 local client 也走同一套
WebSocket protocol 和 session 上报路径，所以工作台对本机和远端节点的处理保持一致。
只有 server 需要作为纯控制面运行时，才使用 `tlive server --standalone`。
