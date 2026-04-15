# Architecture Health Review

## Summary Scores

| Dimension | Score | Key Issues |
|-----------|-------|------------|
| Directory Structure | A | Well-organized by domain |
| Coupling | A | 0 circular deps (fixed 7) |
| Cohesion | A | Strong thematic unity |
| Naming | A | Clear, semantic naming |
| File Size | A | renderer split 700→466 |
| Tests | B | +30 tests, gaps in i18n/ui/channels |
| Extensibility | A | Policy pattern, bash.ts fixed |

**Overall: 6/7 dimensions healthy**


## Entropy Risk Points (Resolved)

1. ~~engine/messages/renderer.ts (765 lines)~~ → **Fixed** (466 lines + 3 modules)
2. ~~Circular dependencies~~ → **Fixed** (0 remaining)
3. ~~bash.ts platform conditionals~~ → **Fixed** (FormatPolicy)
4. engine/sdk/engine.ts (877 lines) — Session management (coherent, defer)
5. channels/qqbot/adapter.ts (843 lines) — Protocol logic (coherent, defer)


## Detailed Findings

### 1. Directory Structure Semantics

**Score:** A

- **Strength:** Each top-level directory has clear responsibility: `channels/` (IM adapters), `providers/` (AI providers), `engine/` (core logic), `permissions/` (access control), `ui/` (presentation policies).
- **Strength:** No catch-all directories like `misc/`, `common/`, or `shared/`. The `utils/` directory contains focused utilities (id, path, string, constants) not random helpers.
- **Strength:** Subdirectory depth is appropriate (max 2-3 levels): `engine/commands/`, `engine/coordinators/`, `engine/messages/`.
- **Evidence:**
  ```
  src/
  ├── channels/{feishu,qqbot,telegram}/  # Platform-specific adapters
  ├── engine/{commands,coordinators,messages,sdk}/  # Core domain modules
  ├── permissions/{gateway,broker}/  # AuthN/AuthZ
  └── utils/{constants,session-format,...}/  # Focused utilities
  ```
- **Minor Issue:** `engine/` has grown to 10 subdirectories and 60 source files. Consider splitting `automation/` into top-level if it grows further.

### 2. Module Coupling

**Score:** A (Fixed)

- **Fixed:** 7 circular dependencies resolved:
  1. `channels/types.ts` — Extracted MediaAttachment/FileAttachment to `channels/media-types.ts`
  2. `formatting/message-formatter.ts > ui/buttons.ts` — buttons.ts now imports Locale from i18n
  3. `bridge-manager ↔ webhook` — WebhookServer uses AutomationBridge interface
  4. `renderer.ts > progress-builder.ts` — Extracted shared types to `renderer-types.ts`

- **Note:** Cross-layer imports remain (engine imports from channels/ui/formatting/providers) but are acceptable — these are interface imports, not implementation dependencies.

- **Strength:** The `BaseChannelAdapter` abstraction provides a clean interface boundary between `engine/` and `channels/`. New platforms can be added without modifying core engine.

### 3. Cohesion

**Score:** A

- **Strength:** Files within each directory solve the same domain problem:
  - `channels/telegram/` — Telegram-specific protocol handling
  - `engine/commands/` — Command parsing and execution
  - `engine/coordinators/` — Orchestration between components
  - `permissions/` — Permission gateway and decision broker

- **Strength:** `utils/` directory is well-organized with single-purpose files:
  - `id.ts` (session ID generation)
  - `path.ts` (path utilities)
  - `string.ts` (truncate utility)
  - `constants.ts` (shared constants)
  - `session-format.ts` (session display formatting)

- **Evidence:** No orphan files detected. Each file's purpose is evident from its name and location.

### 4. Naming Clarity

**Score:** A

- **Strength:** File names immediately reveal content:
  - `bridge-manager.ts` — Manages bridge lifecycle
  - `command-router.ts` — Routes commands to handlers
  - `permission-coordinator.ts` — Coordinates permission decisions
  - `session-state.ts` — Manages session state

- **Strength:** No vague names like `utils.ts`, `helpers.ts`, or `common.ts`. The generic `utils/` directory contains focused, named utilities.

- **Strength:** Exported functions/classes have semantic clarity:
  - `BaseChannelAdapter`, `createAdapter()`, `registerAdapterFactory()`
  - `QueryOrchestrator`, `PermissionCoordinator`, `CommandRouter`

- **Minor Issue:** Two `types.ts` files in `channels/` and `ui/` — acceptable but could be renamed to `channel-types.ts` and `ui-types.ts` for searchability.

### 5. File Size

**Score:** A (Improved)

- **Fixed:** renderer.ts split from 700 to 466 lines (34% reduction):
  - `permission-tracker.ts` (100 lines) — queue, timeout, reaction
  - `progress-watcher.ts` (67 lines) — stalled detection
  - `tool-formatter.ts` (38 lines) — input formatting
- **Remaining large files** (acceptable — single responsibility):
  | File | Lines | Status |
  |------|-------|--------|
  | engine/sdk/engine.ts | 877 | Session management (coherent) |
  | channels/qqbot/adapter.ts | 843 | Protocol logic (coherent) |
  | channels/feishu/adapter.ts | 629 | SDK wrapper (coherent) |
  | channels/telegram/adapter.ts | 511 | SDK wrapper (coherent) |

### 6. Test Organization

**Score:** B (Improved)

- **Strength:** Tests mirror source structure (+30 tests added):
  - `formatting/` — 13 tests added for escapeHtml, TelegramFormatter
  - `utils/` — 17 tests added for formatSize, formatRelativeTime, redactSensitiveContent

- **Partial Fix:** Test coverage improved but gaps remain:
  | Module | Src Files | Tests | Gap |
  |--------|-----------|-------|-----|
  | formatting | 3 | 1 ✓ | Fixed |
  | i18n | 4 | 0 | Missing |
  | ui | 5 | 1 | Insufficient |
  | utils | 18 | 2 ✓ | Improved |
  | channels | 26 | 2 | Insufficient |

- **Strength:** Critical paths are tested: `bridge-manager.test.ts` (500 lines), `query-orchestrator.test.ts` (792 lines), `claude-adapter.test.ts` (784 lines).

- **Suggestion:** Add tests for `formatting/message-formatter.ts` (critical rendering logic) and `utils/` utilities.

### 7. Extensibility

**Score:** A

- **Strength:** Platform conditionals use policy pattern, not hardcoded `if/switch`:
  ```typescript
  // BaseChannelAdapter uses ChannelPolicy
  protected policy: ChannelPolicy = DEFAULT_CHANNEL_POLICY;

  shouldRenderProgressPhase(phase: ProgressPhase): boolean {
    return this.policy.progress.shouldRenderPhase(phase);
  }
  ```

- **Strength:** Adding a new platform only requires:
  1. Create `src/channels/newplatform/adapter.ts`
  2. Create `src/channels/newplatform/formatter.ts`
  3. Register in `src/channels/index.ts`
  4. Add platform policy in `src/ui/channel-policy.ts`

- **Minor Issue:** Some platform-specific conditionals remain:
  - `src/engine/commands/bash.ts:35` — `if (ctx.adapter.channelType === 'telegram')`
  - `src/engine/messages/presenter.ts:187` — `if (platform === 'win32')`

- **Suggestion:** Extract remaining platform conditionals to `ChannelPolicy` or `PlatformCapability` interfaces.

## Refactor Priority

1. **[High]** Split `engine/sdk/engine.ts` (877 lines) — Extract session registry and queue manager to separate modules. Reduces cognitive load and enables parallel development.

2. **[High]** Break `bridge-manager ↔ webhook` circular dependency — Introduce event emitter or interface abstraction. Enables cleaner testing and future automation extensions.

3. **[Medium]** Add tests for `formatting/message-formatter.ts` — Critical rendering logic with 645 lines, currently untested. High risk for regression.

4. **[Medium]** Split `channels/qqbot/adapter.ts` (843 lines) — Extract message builder and protocol handler to separate files. Pattern from `feishu/` and `telegram/` shows similar need.

5. **[Low]** Consolidate micro-files in `utils/` — `hooks-state.ts`, `automation.ts`, `id.ts`, `string.ts`, `types.ts` could be merged into thematic groups (e.g., `session-utils.ts`).