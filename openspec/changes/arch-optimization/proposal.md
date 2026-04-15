## Why

The architecture review identified code entropy risks: large files with high complexity (feishu/formatter.ts at 1157 lines, engine/sdk/engine.ts at 877 lines), duplicate directories (src/utils/ vs engine/utils/), deep nesting (coordinators/permission/), and hard-coded platform checks. These issues slow development, increase bug risk, and raise onboarding costs. Addressing them now prevents technical debt accumulation.

## What Changes

- **Refactor feishu/formatter.ts** - Split the 1157-line switch-case formatter into focused modules (format-home.ts, format-permission.ts, format-progress.ts)
- **Merge utils directories** - Consolidate engine/utils/ into src/utils/ to eliminate duplicate utility locations
- **Flatten coordinators/permission/** - Reduce 3-level nesting to 2 levels by extracting permission-*.ts files
- **Replace hard-coded platform checks** - Change `adapter.channelType === 'telegram'` to capability-based checks (e.g., `adapter.supportsPairing?.()`)
- **Extract config structure** - Separate config.ts into interface definitions (config.ts) and defaults (config.defaults.ts)

## Capabilities

### New Capabilities
- `feishu-formatter-modules`: Modular formatter for Feishu message formatting with separated concerns
- `capability-based-adapter-checks`: Platform-agnostic adapter capability interface

### Modified Capabilities
- `utils-consolidation`: Merge engine/utils/ into src/utils/ for single source of utilities

## Impact

- **High impact files**: channels/feishu/formatter.ts, engine/sdk/engine.ts, src/utils/, engine/utils/, coordinators/permission/
- **API changes**: None (internal refactoring only)
- **Dependencies**: None
- **Systems**: IM bridge core, Feishu channel, permission coordination
- **Tests**: Test imports from engine/utils/ will need path updates