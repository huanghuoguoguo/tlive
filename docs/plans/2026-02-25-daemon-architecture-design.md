# TermLive Daemon Architecture Design

**Date:** 2026-02-25
**Status:** Approved

## Problem Statement

Current `tlive <command>` wraps a single process per invocation. Three key limitations:

1. **"Forgot to wrap"** — Command already running, no way to attach remotely
2. **Single-session lifecycle** — Closing terminal kills everything (PTY, Web UI, notifications)
3. **No persistent sessions** — Cannot disconnect and reconnect later

Core use case remains **AI tool interaction monitoring** (Claude Code, Aider, etc.) with remote notification and Web UI control.

## Design Decision: Daemon + Persistent Sessions

Instead of attaching to arbitrary running processes (technically infeasible cross-platform with read/write), TermLive becomes a **session manager** — similar to tmux but with Web UI and smart notifications.

### Why not attach to arbitrary processes?

| Platform | Read Output | Write Input | Feasibility |
|----------|-------------|-------------|-------------|
| Linux | /proc/\<pid\>/fd + ptrace | ptrace inject | Requires root/CAP_SYS_PTRACE |
| macOS | Similar but SIP restricts ptrace | Same | Harder, Apple restrictions |
| Windows | AttachConsole + ReadConsoleOutput | WriteConsoleInput | Limited, polling-based |

Cross-platform reliable attach with read/write is not feasible. The daemon model solves the problem by owning sessions from the start.

## Command Interface

```
tlive daemon start [-p 8080]       # Start background daemon
tlive daemon stop                   # Stop daemon
tlive run <cmd> [args...]           # Start command in daemon session
tlive shell                         # Start monitored shell in daemon
tlive attach [session-id|--last]    # Connect to daemon session
tlive list                          # List active sessions
tlive init                          # Configure shell aliases for auto-wrapping
```

## Architecture

```
+--------------------------------------------------+
|  tlive daemon (background process)                |
|                                                    |
|  +- Session 1: claude ------- PTY -- [claude] -+  |
|  +- Session 2: aider  ------- PTY -- [aider]  -+  |
|  +- Session 3: shell  ------- PTY -- [bash]   -+  |
|                                                    |
|  +- Web Server (HTTP + WebSocket) -------------+  |
|  +- Smart Idle Detector (per session) ---------+  |
|  +- Notifier (WeChat/Feishu) ------------------+  |
+--------------------------------------------------+
         ^              ^              ^
         |              |              |
    Local terminal   Phone Web UI   Another PC
    tlive attach     QR code scan   Browser
```

### Daemon Core

- Background process, owns all PTY instances
- **IPC:** Unix domain socket (`~/.termlive/daemon.sock`) / Windows Named Pipe (`\\.\pipe\termlive`)
- **Protocol:** JSON-RPC over socket
- **PID file:** `~/.termlive/daemon.pid`
- **Named Pipe security (Windows):** Security descriptor restricted to current user only

### Session Manager

Each Session holds:
- **PTY instance** — child process owner, survives terminal disconnect
- **Broadcast Hub (subscriber pattern):**
  - All `tlive attach` CLI clients
  - All Web UI WebSocket clients
  - Smart Idle Detector for activity analysis
  - Implementation: `chan []byte` with subscriber registry
- **Output ring buffer** — replay recent content on new attach
- **State:** `running` / `idle` / `stopped`

### `tlive attach` — Smooth Local Terminal Experience

Key implementation details:
1. **Raw mode:** `term.MakeRaw(os.Stdin.Fd())` on attach start
2. **Guaranteed restore:** `defer` + signal handler both call `term.Restore` — prevents "broken terminal" on any exit path (Ctrl+D, network disconnect, signal)
3. **SIGWINCH listener:** Window resize sends `{"method": "resize", "params": {"cols": N, "rows": N}}` to daemon via socket
4. **Daemon resize:** Calls PTY `Setsize` to propagate to child process
5. **Buffer replay:** New attach immediately receives recent output to show current state

### `tlive shell` — Anti-Recursion

```go
cmd := exec.Command(os.Getenv("SHELL"))
cmd.Env = append(os.Environ(), "TERMLIVE_ACTIVE=1")
```

Shell aliases/functions check `TERMLIVE_ACTIVE` to prevent nesting.

### `tlive init` — Auto-Wrapping

Injects shell functions into `.bashrc`/`.zshrc`/PowerShell profile:
```bash
# Example generated alias
claude() {
    if [ -n "$TERMLIVE_ACTIVE" ]; then
        command claude "$@"
    else
        tlive run claude "$@"
    fi
}
```

## Security Model

| Aspect | Mechanism |
|--------|-----------|
| Web UI access | Token per daemon instance (generated at start) |
| Socket access (Unix) | File permission `0600` (owner only) |
| Socket access (Windows) | Named Pipe security descriptor (current user only) |
| `tlive run` input scope | Limited to child process (e.g., Claude's input constraints) |
| `tlive shell` input scope | Full shell access — **startup warning required** |

## Pain Point Resolution

| Pain Point | Solution |
|------------|----------|
| "Forgot to wrap" | `tlive shell` monitors all commands; `tlive init` auto-wraps specific commands |
| "Need remote access later" | Daemon persistent sessions — `tlive attach` from any terminal/device |
| Terminal close kills session | PTY owned by daemon, survives terminal disconnect |
| Security (token leak) | `tlive run` limits input to child process; `tlive shell` warns explicitly |
| Non-interactive commands | Short commands naturally exit; no need to reject |

## Migration Phases

| Phase | Content | Deliverable State |
|-------|---------|-------------------|
| 1 | Refactor: extract PTY/session/hub to `internal/daemon` | Current functionality unchanged |
| 2 | Daemon basics: socket IPC + `daemon start/stop` + `run` | Usable daemon mode |
| 3 | Attach: `attach` + multi-session Web UI + buffer replay | Core feature complete |
| 4 | Shell + Init: `shell` + `init` auto-wrapping | Full feature set |

Each phase is independently usable — no need to complete all phases before shipping.

## Technology Choices

- **Language:** Go (current) — excellent for daemon programming, cross-platform PTY support exists
- **IPC:** JSON-RPC over Unix socket / Named Pipe — simple, debuggable
- **PTY:** creack/pty (Unix) + conpty (Windows) — already in use
- **Web:** Current HTTP/WebSocket stack — extended for multi-session
