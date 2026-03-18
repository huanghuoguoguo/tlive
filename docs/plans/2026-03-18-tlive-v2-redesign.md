# TLive v2 Redesign — Simplified Architecture

**Date:** 2026-03-18
**Status:** Draft

## Overview

Redesign TLive from the ground up with clear separation of concerns. Two independent components, two independent entry points, zero overlap.

## Core Insight

| Component | Job | Runtime |
|-----------|-----|---------|
| `tlive` CLI (Go) | PTY wrapper + Web terminal server | Go binary |
| `/tlive` Skill (Node.js Bridge) | Agent SDK + IM bidirectional interaction | Node.js |

They are **aware** of each other (Bridge detects if Go daemon is running → adds web links to IM messages) but **don't depend** on each other.

## Commands

### Go Binary (`tlive`)

```bash
tlive <cmd>                # Wrap command in PTY + serve Web UI
tlive setup                # Configure (IM platforms, port, domain, token)
tlive stop                 # Stop Go daemon (kills all sessions)
tlive install skills       # Install /tlive skill to Claude Code / Codex
tlive install skills --claude
tlive install skills --codex
tlive install skills --all
```

### Claude Code Skill (`/tlive`)

```
/tlive                     # Start Bridge daemon
/tlive setup               # Interactive IM config wizard
/tlive stop                # Stop Bridge
/tlive status              # Show Bridge status
/tlive doctor              # Diagnostics
```

### Codex (natural language)

```
"tlive start"              # Start Bridge
"tlive setup"              # Config wizard
```

## Architecture

```
┌─── Entry 1: Terminal ────────────────────────┐
│                                               │
│  tlive claude --model opus                    │
│    │                                          │
│    ├── Go daemon auto-starts (if not running) │
│    ├── PTY wraps "claude" command             │
│    ├── Web UI serves on :8080                 │
│    └── Prints URL + QR code                   │
│                                               │
│  Phone browser → Web terminal (xterm.js)      │
│                                               │
└───────────────────────────────────────────────┘

┌─── Entry 2: Claude Code ─────────────────────┐
│                                               │
│  /tlive                                       │
│    │                                          │
│    ├── Node.js Bridge daemon starts           │
│    ├── Agent SDK connects to Claude Code      │
│    └── IM adapters connect (TG/DC/Feishu)     │
│                                               │
│  Phone IM → bidirectional chat + permissions  │
│                                               │
│  If Go daemon detected:                       │
│    → IM messages include 🖥 Web terminal link │
│                                               │
└───────────────────────────────────────────────┘
```

## Go Core — What It Does

**One job: Web terminal server.**

```
tlive <cmd>
  1. Check if daemon already running (lock file ~/.tlive/daemon.lock)
  2. If not → start daemon (HTTP server + WebSocket on 127.0.0.1:port)
  3. Create PTY session wrapping <cmd>
  4. Register session with daemon
  5. Print URL + QR code
  6. Relay PTY I/O to local terminal
  7. On exit → remove session
  8. Daemon idle check: if 0 sessions for 15 minutes → auto-shutdown + cleanup lock file
```

### Daemon Lifecycle

- **Auto-start**: first `tlive <cmd>` starts daemon.
- **Auto-shutdown**: 15 minutes with 0 active sessions → daemon exits, cleans up `daemon.lock`.
- **Manual stop**: `tlive stop` kills daemon immediately.
- No zombie processes, no port leaks.

```
tlive stop                 # Stop Go daemon (kills all sessions)
```

### Go Core API

```
GET    /api/status                # Daemon status, version
GET    /api/sessions              # List active PTY sessions
WS     /ws/session/:id           # Terminal WebSocket stream (bidirectional: output + input)
WS     /ws/status                # Status updates stream
GET    /                          # Web UI dashboard
GET    /terminal.html?id=xxx      # Web terminal page
```

No REST endpoint for PTY stdin. Terminal input flows exclusively through the WebSocket connection (`/ws/session/:id`) — the same channel used by xterm.js in the browser. This keeps Go Core as a pure terminal server with zero IM/Bridge coupling.

Auth: Bearer token via header, cookie (`tl_token`), or `?token=` query param. Token auto-generated on first run, stored in `~/.tlive/config.env`.

**Security defaults:**
- Daemon binds `127.0.0.1` by default (LAN/public access requires `--host 0.0.0.0` explicitly)
- Web links in IM use **scoped tokens** (1-hour TTL, read-only, per-session) — main token never exposed in URLs
- Scoped tokens created via `POST /api/tokens/scoped`

### Go Core Does NOT Do

- No IM notifications
- No webhook pushing
- No idle detection
- No hooks injection
- No Agent SDK
- No Node.js dependency
- No REST stdin input — terminal I/O is WebSocket only

### What Changes From Current Code

| Current | v2 |
|---------|-----|
| `tlive-core` binary name | `tlive` |
| `~/.termlive/` | `~/.tlive/` |
| Notification endpoints (`/api/notify`, `/api/notifications`) | Remove |
| Bridge registration endpoints (`/api/bridge/*`) | Keep (Bridge detects daemon via these) |
| Stats endpoints (`/api/stats`) | Keep (Bridge reports token usage) |
| Git status endpoint (`/api/git/status`) | Keep |
| Scoped tokens (`/api/tokens/scoped`) | Keep (for IM web links) |
| `config.toml` (TOML config) | Remove → unified `config.env` (env format) |
| `daemon start` subcommand | Remove (daemon auto-starts from `tlive <cmd>`) |
| `run` subcommand | Remove (default behavior, `tlive <cmd>` = run) |
| `notify` subcommand | Remove |
| `init` subcommand | Replace with `install skills` |
| Idle detection / OutputClassifier | Remove |
| Webhook notification code | Remove |

### New: `tlive install skills`

```go
func installSkills(target string) {
    // target: "claude", "codex", "all"
    // 1. Determine skill directory
    //    claude: ~/.claude/skills/tlive/
    //    codex:  ~/.codex/skills/tlive/
    // 2. Find the installed npm package directory (where SKILL.md + bridge/dist/ live)
    //    e.g. via: dirname(os.Executable()) or known npm global path
    // 3. Create symlink: skillDir → npm package root
    //    No npm install/build needed — already done by npm install -g tlive
    // 4. Print success message
}
```

Since users install via `npm install -g tlive`, everything (Bridge, SKILL.md) is already built and available. `install skills` just creates a symlink so Claude Code / Codex can discover it.

For users who install Go binary directly (without npm): `install skills` copies only SKILL.md and prints instructions to install Bridge separately via npm.

## Node.js Bridge — What It Does

**One job: IM bidirectional interaction via Agent SDK.**

### Bridge Daemon Lifecycle

Started by `/tlive` skill command or `tlive start-bridge` CLI.

```
Bridge starts
  1. Load config from ~/.tlive/config.env
  2. Try connecting to Go daemon (optional)
     → Success: coreAvailable = true (IM messages will include web links)
     → Fail: coreAvailable = false (IM-only mode, no web links)
  3. Start enabled IM adapters (Telegram/Discord/Feishu)
  4. Wait for IM messages
```

### Message Flow (IM → Claude Code)

```
User sends IM: "Fix the login bug"
  → IM adapter receives
  → Agent SDK query({ prompt: "Fix the login bug", ... })
  → Claude Code subprocess starts (or resumes session)
  → Streaming response → IM
  → Permission request → IM buttons [Allow] [Deny]
  → User taps Allow → SDK continues
  → Result → IM notification
     → If coreAvailable: append "🖥 View Terminal → URL"
```

### Session Isolation

Bridge sessions (Agent SDK) and PTY sessions (Go Core) are completely independent:

| | Bridge Sessions | PTY Sessions |
|---|---|---|
| Created by | IM message → Agent SDK `query()` | `tlive <cmd>` in terminal |
| Managed by | Node.js Bridge | Go daemon |
| Interaction | IM bidirectional | Web terminal (xterm.js) |
| Cross-talk | No | No |

Bridge does NOT write to PTY stdin. PTY does NOT feed into Agent SDK. They are two separate ways to use Claude Code.

### Bridge Does NOT Do

- No PTY management
- No Web UI serving
- No terminal rendering

### What Changes From Current Bridge Code

| Current | v2 |
|---------|-----|
| CoreClient required for startup | CoreClient optional (graceful degradation) |
| Bridge always needs Core | Bridge works independently |
| `main.ts` fails if Core unreachable | `main.ts` logs warning, continues |

## Skill (SKILL.md)

Located at repo root. Installed to `~/.claude/skills/tlive/` or `~/.codex/skills/tlive/`.

```yaml
---
name: tlive
description: |
  IM bridge for AI coding tools. Chat with Claude Code / Codex from
  Telegram, Discord, or Feishu. Start bridge, configure IM platforms,
  check status.
argument-hint: "setup | stop | status | doctor"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
  - Grep
  - Glob
---
```

### Subcommands

| Input | Action |
|-------|--------|
| (no args), `start`, `启动` | Start Bridge daemon |
| `setup`, `配置` | Interactive IM config |
| `stop`, `停止` | Stop Bridge daemon |
| `status`, `状态` | Show Bridge + Go daemon status |
| `doctor`, `诊断` | Diagnostics |

### `/tlive` (no args) — Start Bridge

```
1. Check ~/.tlive/config.env exists → if not, auto-start setup
2. Check Bridge already running (PID file) → if yes, show status
3. Start Bridge: node SKILL_DIR/bridge/dist/main.mjs &
4. Write PID to ~/.tlive/runtime/bridge.pid
5. Report: "Bridge started. Connected to: Telegram ✓ Discord ✓"
6. If Go daemon detected: "Web terminal available at http://..."
```

### Runtime Detection

```
AskUserQuestion available? → Claude Code environment
Not available? → Codex / other → non-interactive guidance
```

## Directory Structure

```
tlive/                          # Repo root
├── SKILL.md                    # Skill definition
├── config.env.example          # Config template
├── core/                       # Go source
│   ├── cmd/tlive/              # CLI entry (renamed from tlive-core)
│   │   ├── main.go             # Root command: tlive <cmd> = run
│   │   └── install.go          # tlive install skills
│   ├── internal/
│   │   ├── daemon/             # HTTP server, session manager
│   │   ├── server/             # WebSocket handlers
│   │   ├── session/            # Session state
│   │   ├── hub/                # Broadcast hub
│   │   ├── pty/                # PTY abstraction
│   │   └── config/             # Config
│   └── web/                    # Embedded Web UI
├── bridge/                     # Node.js source
│   └── src/
│       ├── main.ts             # Bridge daemon entry
│       ├── config.ts           # Config loader
│       ├── core-client.ts      # Optional Go daemon detection
│       ├── providers/          # Agent SDK
│       ├── channels/           # Telegram, Discord, Feishu
│       ├── engine/             # Conversation engine, bridge manager
│       ├── permissions/        # Permission gateway
│       ├── delivery/           # Message delivery
│       ├── markdown/           # Per-platform rendering
│       └── store/              # Persistence
├── scripts/
│   ├── postinstall.js          # Download Go binary on npm install
│   └── statusline.sh           # Claude Code status line
├── package.json                # npm: tlive
├── docker-compose.yml
└── .github/workflows/
```

## Runtime Directory

```
~/.tlive/
├── config.env                  # Unified config (Core + Bridge)
├── daemon.lock                 # Go daemon lock file (port, token, pid)
├── runtime/
│   └── bridge.pid              # Bridge PID
├── data/                       # Bridge persistence
├── logs/
│   ├── tlive.log               # Go Core log
│   └── bridge.log              # Bridge log
└── bin/
    └── statusline.sh           # Status line script
```

## Config

**Unified**: Both Go Core and Bridge read the same `~/.tlive/config.env` file. No `.toml`.

```env
# Core
TL_PORT=8080
TL_TOKEN=auto-generated-32char-hex
TL_HOST=127.0.0.1                    # Default: localhost only. Set 0.0.0.0 for LAN access.
TL_PUBLIC_URL=https://example.com     # Optional: for web links in IM messages

# IM Platforms
TL_ENABLED_CHANNELS=telegram,discord
TL_TG_BOT_TOKEN=...
TL_TG_ALLOWED_USERS=...
TL_DC_BOT_TOKEN=...
TL_DC_ALLOWED_CHANNELS=...
TL_FS_APP_ID=...
TL_FS_APP_SECRET=...

# Runtime
TL_RUNTIME=claude
```

`tlive setup` writes this single file. Go Core parses env vars on startup: `TL_PORT`, `TL_TOKEN`, `TL_HOST`. Bridge parses all vars via `config.ts`.

## Detection: Bridge ↔ Go Daemon

Bridge checks Go daemon on startup and periodically:

```typescript
async function detectCore(): Promise<boolean> {
  try {
    const resp = await fetch(`http://localhost:${config.port}/api/status`, {
      headers: { Authorization: `Bearer ${config.token}` },
    });
    return resp.ok;
  } catch {
    return false;
  }
}
```

When `coreAvailable`:
- IM notifications include `🖥 View Terminal → URL` (using scoped tokens)
- `/tlive status` shows "Web terminal: available at http://..."

When `!coreAvailable`:
- Pure IM mode, no web links
- Everything else works normally

## Status Line

`~/.tlive/bin/statusline.sh` — reads Claude Code session JSON from stdin, queries Go daemon if available:

```
TL: web:on | bridge:on | 12k tok | $0.08     # Both running
TL: bridge:on | 12k tok | $0.08              # Bridge only
TL: web:on | 2 sessions                       # Go daemon only
```

## Implementation Plan

### Phase 1: Go Core Simplification
1. Rename binary: `tlive-core` → `tlive`
2. Rename dirs: `~/.termlive/` → `~/.tlive/`, `cmd/tlive-core/` → `cmd/tlive/`
3. Make `tlive <cmd>` the default (remove `run` subcommand, args after `tlive` = command to wrap)
4. Remove: notification endpoints, webhook code, idle detection
5. Replace config: remove TOML, read `~/.tlive/config.env` (parse TL_PORT, TL_TOKEN, TL_HOST)
6. Default bind `127.0.0.1` (configurable via TL_HOST)
7. Add: daemon idle auto-shutdown (15 min with 0 sessions)
8. Add: `tlive stop` command
9. Add: `tlive setup` command (interactive config, writes unified config.env)
10. Add: `tlive install skills` command (symlink to npm package)

### Phase 2: Bridge Simplification
1. Make Core connection optional (graceful degradation)
2. Update `main.ts` to work without Core
3. Add web link injection when Core is available (use scoped tokens, not main token)
4. Bridge reads same `~/.tlive/config.env` as Core

### Phase 3: SKILL.md Update
1. Rewrite for new command structure
2. `/tlive` = start bridge
3. Runtime detection (Claude Code vs Codex)

### Phase 4: Packaging
1. Rename npm package to `tlive`
2. Update `postinstall.js` for new binary name
3. Update `docker-compose.yml`
4. Update README + README_CN
