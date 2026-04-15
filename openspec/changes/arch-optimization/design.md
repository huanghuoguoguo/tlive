## Context

The tlive codebase has grown to ~20,720 lines across 135 source files. An architecture review identified entropy risks: large files with high cyclomatic complexity (feishu/formatter.ts at 1157 lines with extensive switch-case logic), duplicate directories (src/utils/ and engine/utils/), deep nesting (coordinators/permission/), and hard-coded platform type checks. These patterns slow development velocity and increase bug risk.

## Goals / Non-Goals

**Goals:**
- Reduce feishu/formatter.ts complexity by splitting into focused modules
- Eliminate duplicate utils directories for single source of truth
- Flatten deep directory nesting where it adds no value
- Replace hard-coded platform checks with capability-based interfaces

**Non-Goals:**
- Refactoring engine/sdk/engine.ts (877 lines) - out of scope for this change
- Renaming canonical/ directory
- Adding new features or capabilities
- Changing external APIs

## Decisions

### 1. Feishu Formatter Split Strategy

**Decision:** Split by message type domain (home, permission, progress) rather than by technical concern (formatting, validation, etc.)

**Rationale:**
- Each message type (home, permission, progress) has self-contained formatting logic
- Domain split aligns with how new message types are added
- Router pattern in main formatter keeps dispatch logic simple

**Alternative considered:** Split by technical layer (formatters, validators, builders) - rejected because it increases cross-file navigation for a single message type change.

### 2. Utils Merge Strategy

**Decision:** Merge engine/utils/ into src/utils/, update all imports

**Rationale:**
- src/utils/ is the established convention in the codebase
- Files in engine/utils/ (router.ts, conversation.ts, cost-tracker.ts) are general utilities with no engine-specific dependencies
- Single utils location reduces cognitive load

**Alternative considered:** Keep both but add clear naming (engine-utils/, core-utils/) - rejected because it adds complexity without benefit.

### 3. Permission Directory Flattening

**Decision:** Extract permission/*.ts files to coordinators/permission-*.ts

**Rationale:**
- 3-level nesting (coordinators/permission/*.ts) for 3 files is unnecessary
- Flattened structure: coordinators/permission-coordinator.ts, coordinators/permission-broker.ts, coordinators/permission-gateway.ts
- Consistent with other coordinators which are flat

### 4. Capability-Based Adapter Checks

**Decision:** Add `supportsX()` methods to BaseChannelAdapter, default implementations return false

**Rationale:**
- Hard-coded checks (`adapter.channelType === 'telegram'`) break when adding new platforms
- Capability methods (supportsPairing, supportsStreaming, etc.) are explicit and extensible
- Default implementations maintain backward compatibility

**Alternative considered:** Use adapter capabilities object - rejected because method-based checks are simpler and don't require runtime capability registration.

## Risks / Trade-offs

- **Risk:** Import path updates may miss some files → Mitigation: Use IDE refactoring + grep verification
- **Risk:** Test files may have stale imports → Mitigation: Run full test suite after each subtask
- **Risk:** Formatter split may introduce circular dependencies → Mitigation: Verify with madge before committing