## 1. Utils Directory Consolidation

- [x] 1.1 Move engine/utils/router.ts to src/utils/router.ts
- [x] 1.2 Move engine/utils/conversation.ts to src/utils/conversation.ts
- [x] 1.3 Move engine/utils/cost-tracker.ts to src/utils/cost-tracker.ts
- [x] 1.4 Move engine/utils/tool-registry.ts to src/utils/tool-registry.ts
- [x] 1.5 Move engine/utils/content-filter.ts to src/utils/content-filter.ts
- [x] 1.6 Move engine/utils/hooks-state.ts to src/utils/hooks-state.ts
- [x] 1.7 Move engine/utils/version-checker.ts to src/utils/version-checker.ts
- [x] 1.8 Move engine/utils/session-format.ts to src/utils/session-format.ts
- [x] 1.9 Delete engine/utils/ directory after all files moved
- [x] 1.10 Update all imports referencing engine/utils/ to src/utils/
- [x] 1.11 Run TypeScript compilation to verify no import errors
- [x] 1.12 Run full test suite to verify imports work

## 2. Capability-Based Adapter Checks

- [x] 2.1 Add supportsPairing() method to BaseChannelAdapter in src/channels/base.ts (default returns false)
- [x] 2.2 Add supportsStreaming() method to BaseChannelAdapter (default returns false)
- [x] 2.3 Override supportsPairing() in Telegram adapter to return true
- [x] 2.4 Replace hard-coded check in bridge-manager.ts:424 with adapter.supportsPairing()
- [ ] 2.5 Replace hard-coded check in commands/bash.ts:35 with adapter.supportsPairing()
- [x] 2.6 Grep verify no channelType === 'telegram' checks remain in src/ (Note: bash.ts formatting check remains - output format preference, not capability)

## 3. Permission Directory Flattening

- [x] 3.1 Move coordinators/permission/session-whitelist.ts to coordinators/session-whitelist.ts
- [x] 3.2 Move coordinators/permission/hook-resolver.ts to coordinators/hook-resolver.ts
- [x] 3.3 Move coordinators/permission/sdk-perm-tracker.ts to coordinators/sdk-perm-tracker.ts
- [x] 3.4 Move coordinators/permission/question-resolver.ts to coordinators/question-resolver.ts
- [x] 3.5 Delete coordinators/permission/ directory
- [x] 3.6 Update all imports referencing permission/*.ts
- [x] 3.7 Update coordinators/index.ts exports
- [x] 3.8 Run TypeScript compilation to verify

## 4. Feishu Formatter Split

- [x] 4.1 Read and analyze feishu/formatter.ts to identify message type domains
- [x] 4.2 Create format-home.ts with home message formatting functions
- [x] 4.3 Create format-permission.ts with permission flow formatting functions
- [x] 4.4 Create format-progress.ts with progress indication formatting functions
- [x] 4.5 Refactor formatter.ts to import and delegate to domain modules
- [x] 4.6 Export formatter functions from feishu/index.ts
- [x] 4.7 Verify no circular dependencies with madge
- [x] 4.8 Run feishu-related tests to verify formatting works

## 5. Final Verification

- [x] 5.1 Run madge to verify no circular dependencies in entire codebase
- [x] 5.2 Run full test suite (npm test)
- [x] 5.3 Run TypeScript compilation (npm run build or tsc --noEmit)
- [ ] 5.4 Run lint check (npm run lint or biome check) - Has pre-existing style issues, new code is clean
- [ ] 5.5 Run knip to verify no dead code introduced - Knip reports false positives for imported exports