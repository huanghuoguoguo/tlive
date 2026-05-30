# Server / Client Architecture

TLive is split into three code areas:

- `src/server/`: control plane. It owns IM adapters, Feishu/Lark topics, workbench cards,
  command routing, client registry, permissions, and dispatching control messages.
- `src/client/`: execution plane. It connects to the server, reports local providers,
  workspaces, and SDK sessions, and executes Claude Code / Codex / Pi turns.
- `src/shared/`: dependency-free contracts and utilities used by both sides, including protocol
  messages, provider capability types, formatting types, i18n, and core helpers.

State ownership follows the same boundary:

- The server may persist IM routing state, such as chat bindings and topic mappings.
- Clients own SDK runtime state and session discovery. They report session descriptors to the
  server through the remote protocol.
- The workbench is an aggregation view. It should not scan local Claude/Codex/Pi history as a global
  source of truth.

The CLI starts the server plus a `local` execution client by default. That local client uses the
same WebSocket protocol and session reporting path as remote clients, so the workbench treats local
and remote nodes consistently. Use `tlive server --standalone` when the server should be a pure
control plane with no local worker.
