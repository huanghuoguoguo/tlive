## 0. Phase 0: Low-risk Cleanup

- [x] 0.1 Delete `src/engine/index.ts` barrel file (zero consumers, dead code)
- [x] 0.2 Rename `src/messages/` → `src/canonical/` using `git mv`
- [x] 0.3 Update import paths in affected files (providers/, engine/state/, engine/utils/)
- [x] 0.4 Run `npm run build && npm test && npm run lint:dead` to verify

## 1. Phase 1: Split PermissionCoordinator

### 1.1 Create Sub-components

- [x] 1.1.1 Create `src/engine/coordinators/permission/` directory
- [x] 1.1.2 Create `sdk-perm-tracker.ts` with SdkPermTracker class (~120 lines)
- [x] 1.1.3 Create `hook-resolver.ts` with HookResolver class (~100 lines)
- [x] 1.1.4 Create `question-resolver.ts` with QuestionResolver class (~150 lines)
- [x] 1.1.5 Create `session-whitelist.ts` with SessionWhitelist class (~60 lines)

### 1.2 Convert PermissionCoordinator to Facade

- [x] 1.2.1 Import all 4 sub-components in `permission.ts`
- [x] 1.2.2 Create instances of sub-components in constructor
- [x] 1.2.3 Add getter methods: `get sdk()`, `get hooks()`, `get questions()`, `get whitelist()`
- [x] 1.2.4 Delegate existing methods to appropriate sub-components
- [x] 1.2.5 Keep all public method signatures unchanged (backward compatibility)

### 1.3 Testing

- [x] 1.3.1 Run existing `permission-coordinator.test.ts` tests (should pass)
- [x] 1.3.2 Add unit tests for each sub-component if needed

## 2. Phase 2: Slim BridgeManager

### 2.1 Create BridgeFactory

- [x] 2.1.1 Create `src/engine/bridge-factory.ts`
- [x] 2.1.2 Define `BridgeComponents` interface with all component fields
- [x] 2.1.3 Extract `createBridgeComponents()` function from BridgeManager constructor
- [x] 2.1.4 Move 16 component instantiations to factory function

### 2.2 Define AutomationBridge Interface

- [x] 2.2.1 Create `src/engine/types/automation-bridge.ts` (or add to existing types)
- [x] 2.2.2 Define `AutomationBridge` interface with minimal methods:
  - `getAdapter(channelType)`
  - `getAdapters()`
  - `getLastChatId(channelType)`
  - `injectAutomationPrompt(options)`
  - `hasActiveSession(...)`
  - `getBinding(...)`
  - `getBindingBySessionId(...)`

### 2.3 Simplify BridgeManager

- [x] 2.3.1 Replace 17 fields with single `components: BridgeComponents`
- [x] 2.3.2 Call `createBridgeComponents()` in constructor
- [x] 2.3.3 Remove forwarding methods (trackHookMessage, trackPermissionMessage, etc.)
- [x] 2.3.4 Update HookNotificationDispatcher to receive permissions directly
- [x] 2.3.5 Update WebhookServer/CronScheduler to depend on AutomationBridge

### 2.4 Testing

- [x] 2.4.1 Update BridgeManager tests to use `createBridgeComponents()` directly
- [x] 2.4.2 Update automation integration tests
- [x] 2.4.3 Run `npm test` to verify

## 3. Phase 3: Extract HomePayloadBuilder

- [x] 3.1 Create `src/engine/presenters/home-payload-builder.ts`
- [x] 3.2 Move `buildHomePayload` logic (~90 lines) to HomePayloadBuilder
- [x] 3.3 Define constructor with dependencies (store, state, workspace, permissions, etc.)
- [x] 3.4 Move `formatSessionDate`, `formatRelativeTime` to `engine/utils/session-format.ts`
- [x] 3.5 Update CommandRouter to use HomePayloadBuilder via dependency injection
- [x] 3.6 Run `npm test` to verify CommandRouter tests pass

## 4. Phase 4: Simplify QueryOrchestrator

- [x] 4.1 Create `src/engine/coordinators/query-context.ts`
- [x] 4.2 Define QueryContext class with all execution parameters
- [x] 4.3 Update `executeQuery` signature to accept single QueryContext
- [x] 4.4 Update callers to construct QueryContext before calling executeQuery
- [x] 4.5 Run `npm test` to verify query tests pass

## 5. OCP Fixes: Channel Extensibility

### 5.1 Add Virtual Methods to BaseChannelAdapter

- [x] 5.1.1 Add `prepareBroadcast(msg: RenderedMessage): BroadcastContext` to base.ts
- [x] 5.1.2 Add `classifyError(err: unknown): BridgeError` to base.ts
- [x] 5.1.3 Implement default/base implementations

### 5.2 Implement in Platform Adapters

- [x] 5.2.1 Implement `FeishuAdapter.prepareBroadcast` (set receive_id_type)
- [x] 5.2.2 Implement `TelegramAdapter.classifyError` (handle grammy errors)
- [x] 5.2.3 Implement `FeishuAdapter.classifyError` (handle Feishu SDK errors)
- [x] 5.2.4 Implement `QQBotAdapter.classifyError` (handle QQBot errors)

### 5.3 Remove Engine Platform Dependencies

- [x] 5.3.1 Remove `FeishuRenderedMessage` import from bridge-manager.ts
- [x] 5.3.2 Remove `if (channelType === 'feishu')` broadcast logic
- [x] 5.3.3 Use `adapter.prepareBroadcast()` instead

### 5.4 Deprecate classifyError Switch

- [x] 5.4.1 Update callers in channels/ to use `adapter.classifyError(err)`
- [x] 5.4.2 Remove `classifyError(channel, err)` switch from errors.ts
- [x] 5.4.3 Run `npm test` to verify

## 6. Final Verification

- [x] 6.1 Run `npm run build` (must pass)
- [x] 6.2 Run `npm test` (all 600+ tests must pass)
- [x] 6.3 Run `npm run lint:dead` (no new dead code)
- [x] 6.4 Verify no new circular dependencies
- [ ] 6.5 Merge all Phase PRs to main