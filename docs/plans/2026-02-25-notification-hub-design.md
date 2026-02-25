# TermLive Notification Hub Architecture Design

**Date:** 2026-02-25
**Status:** Approved
**Supersedes:** 2026-02-25-daemon-architecture-design.md (partially)

## Problem Statement

The original TermLive architecture relies on PTY output monitoring and pattern matching
to detect when an AI tool is idle or awaiting input. This approach suffers from:

- **False positives**: API calls, long builds, and "thinking" time all look idle at PTY level
- **Monitoring overhead**: Parsing every byte of terminal output is wasteful
- **Limited accuracy**: Pattern matching can never be as accurate as the AI itself

### Key Insight

AI code tools like Claude Code already have rules/skills/hooks systems. Instead of
observing the AI from outside (PTY monitoring), we can tell the AI to notify us directly
through its own extensibility system. The AI already knows when it's waiting or done —
we just need to give it a way to tell us.

## Architecture Overview

### Three-Layer Notification Strategy

```
Priority 1: Hooks (automatic)  → Event-driven, zero AI cooperation needed
Priority 2: Skills (AI-driven) → AI proactively calls when rules instruct it
Priority 3: PTY (fallback)     → Pattern matching for tools without skills support
```

### Two Running Modes

**Full Mode** (`tlive run claude`): PTY wrapping + Web UI remote terminal + all three
notification layers active.

**Lite Mode** (`tlive daemon start` + `claude`): Notification service only. No terminal
capture. Skills and hooks send notifications; Web UI shows notification history.

### System Diagram

```
┌─────────────────────────────────────────────┐
│  tlive init (one-time setup)                 │
│  Generates: skills + rules + hooks + config  │
└──────────────────┬──────────────────────────┘
                   │
     ┌─────────────┼─────────────┐
     ▼             ▼             ▼
  Hooks         Skills        PTY Monitor
  (auto)        (AI-driven)   (fallback)
     │             │             │
     └─────────────┼─────────────┘
                   ▼
           tlive notify CLI
                   │
                   ▼
         ┌─────────────────┐
         │  Daemon (light)  │
         │  - HTTP API      │
         │  - Web UI        │
         │  - Notify Relay  │
         │  - History Store │
         └─────────────────┘
                   │
     ┌─────────────┼─────────────┐
     ▼             ▼             ▼
   WeChat       Feishu        Web UI
```

## Command Interface

```
tlive init [--tool claude-code] [--yes]    # Initialize project (generate skills/rules/hooks)
tlive daemon start [-p 8080]               # Start notification service + Web UI
tlive daemon stop                          # Stop daemon
tlive run <cmd> [args...]                  # PTY-wrapped launch (full mode)
tlive notify --type <type> --message <msg> # Send notification to daemon
tlive list                                 # List active sessions / notifications
tlive status                               # Daemon status
```

## `tlive init` Generated Files

### File Layout

```
project-root/
├── .claude/
│   ├── settings.local.json          # Hooks configuration
│   └── skills/
│       └── termlive-notify/
│           └── SKILL.md             # Notification skill
├── CLAUDE.md                        # Appended TermLive rules (preserves existing)
└── .termlive.toml                   # TermLive configuration
```

### Generated Skill (SKILL.md)

```markdown
---
name: termlive-notify
description: Use when a task completes, needs user confirmation,
  or you want to report progress to the user
---

# TermLive Notify

## When to Use
- Task completed or milestone reached
- Need user confirmation or decision
- Encountered an error that requires user attention
- Long-running task progress update

## How to Notify
Run via Bash tool:
  tlive notify --type done --message "Completed: <summary>"
  tlive notify --type confirm --message "Need approval: <details>"
  tlive notify --type error --message "Error: <details>"
  tlive notify --type progress --message "Progress: <details>"
```

### Generated Rules (appended to CLAUDE.md)

```markdown
## TermLive Notification Rules
- When you complete a significant task, invoke the termlive-notify skill
- When you need user confirmation, invoke the termlive-notify skill
- When you encounter a blocking error, invoke the termlive-notify skill
```

### Generated Hooks (settings.local.json)

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "AskUserQuestion",
      "hooks": [{
        "type": "command",
        "command": "tlive notify --type confirm --message 'AI is waiting for your input'"
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "tlive notify --type done --message 'Session ended'"
      }]
    }]
  }
}
```

### Generated Config (.termlive.toml)

```toml
[daemon]
port = 8080
auto_start = false

[notify]
channels = ["web"]          # web / wechat / feishu
# wechat_webhook = ""
# feishu_webhook = ""

[notify.options]
include_context = true      # Include context in AI notifications
history_limit = 100         # Number of notifications to keep in Web UI
```

## Daemon Architecture

### Responsibility (Lightweight)

| Responsibility | Description |
|----------------|-------------|
| HTTP API | Receives notifications from `tlive notify` CLI |
| Web UI | Notification dashboard + real-time terminal (full mode only) |
| Notify Relay | Forwards to WeChat / Feishu / custom webhooks |
| Session Mgmt | PTY session management (full mode only) |
| History Store | Stores recent notifications for Web UI display |

### Notify HTTP API

```
POST /api/notify
Authorization: Bearer <token>
Content-Type: application/json

{
  "type": "done|confirm|error|progress",
  "message": "Task completed: implemented auth module",
  "context": "optional additional context",
  "session_id": "optional, auto-detect if omitted"
}

Response: 200 OK
{ "id": "notif_001", "timestamp": "2026-02-25T10:30:00Z" }
```

```
GET /api/notifications?limit=50
Authorization: Bearer <token>

Response: 200 OK
{ "notifications": [...], "total": 42 }
```

### `tlive notify` CLI

Thin wrapper that reads `.termlive.toml` for daemon address and token, then calls
the HTTP API. Designed to be fast and non-blocking so it doesn't slow down hooks.

## Data Flow

### Full Mode

```
Claude Code (inside PTY)
  │
  ├─[Hook auto] AskUserQuestion triggered
  │   → shell: tlive notify --type confirm ...
  │   → HTTP POST /api/notify
  │   → Daemon: store + relay to WeChat/Feishu + WebSocket push to Web UI
  │
  ├─[Skill manual] AI decides task is done
  │   → Bash tool: tlive notify --type done --message "..."
  │   → same as above
  │
  └─[PTY fallback] No output beyond threshold
      → SmartIdleDetector triggers
      → Daemon internally calls Notifier
      → Relay to WeChat/Feishu + Web UI
```

### Lite Mode

```
Claude Code (launched directly)
  │
  ├─[Hook auto] → tlive notify → Daemon API
  └─[Skill manual] → tlive notify → Daemon API

(No PTY fallback. Web UI shows notification history only.)
```

## Error Handling

| Scenario | Handling |
|----------|----------|
| Daemon not running when `tlive notify` called | Silent fail + stderr hint. Never block AI. |
| Hook execution failure | Claude Code handles internally. No impact on main flow. |
| Notification channel send failure | Retry once, mark as failed in history. |
| Token mismatch | Return 401. CLI suggests re-running `tlive init`. |
| Config file missing | `tlive notify` searches default locations, errors if not found. |

## Code Organization

```
internal/
├── daemon/
│   ├── daemon.go           // Daemon lifecycle and main struct
│   ├── api.go              // HTTP API handlers (notify, history, sessions)
│   └── notification.go     // NotificationStore (in-memory + optional persistence)
├── notify/                 // Notification channels (existing, reused)
│   ├── notifier.go         // Notifier interface
│   ├── wechat.go           // WeChat webhook
│   └── feishu.go           // Feishu webhook
├── generator/              // tlive init generation logic
│   ├── generator.go        // Generator interface + orchestrator
│   ├── claude_code.go      // Claude Code adapter (skills/rules/hooks)
│   └── templates/          // Embedded template files
├── session/                // Session model (existing, reused)
├── pty/                    // PTY layer (existing, reused for full mode)
├── hub/                    // Broadcast center (existing, reused for full mode)
├── config/                 // Configuration (existing, extended)
└── server/                 // Web UI server (existing, extended)
```

### Relationship to Existing Code

| Module | Action |
|--------|--------|
| `internal/session/` | **Keep** — reused in full mode |
| `internal/pty/` | **Keep** — reused in full mode |
| `internal/hub/` | **Keep** — reused in full mode |
| `internal/notify/` | **Keep + extend** — add NotificationStore |
| `internal/server/` | **Extend** — add notification API endpoints |
| `internal/config/` | **Extend** — add init-related config fields |
| `internal/daemon/manager.go` | **Keep** — reused in full mode |
| `internal/daemon/ipc.go` | **Refactor** — replace JSON-RPC/socket with HTTP API |
| `internal/daemon/daemon.go` | **Rewrite** — new lightweight daemon |
| `internal/daemon/socket*.go` | **Remove** — no longer needed (HTTP replaces socket IPC) |

## Testing Strategy

| Level | What to Test |
|-------|-------------|
| Generator | File content correctness, template rendering, idempotency |
| Notify CLI | Argument parsing, API call mocking |
| Daemon API | HTTP handler unit tests |
| NotificationStore | Store, query, limits, concurrent access |
| Integration | init → daemon start → notify → verify notification arrives |

## AI Tool Support

**First release:** Claude Code only (skills + hooks + CLAUDE.md).

**Architecture ready for:** Future adapters for Cursor (.cursorrules), Aider, and
other tools. The `generator/` package uses an interface that new adapters implement.

## Open Source Considerations

- Clean, well-commented code following Go conventions
- Comprehensive README with quick-start guide
- All generated files are human-readable and editable
- Configuration is transparent — no magic, no hidden state
- Graceful degradation — each notification layer works independently
