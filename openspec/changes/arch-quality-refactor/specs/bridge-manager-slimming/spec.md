## ADDED Requirements

### Requirement: BridgeFactory creates all engine components
BridgeFactory SHALL encapsulate creation of all 16+ engine components in a single function.

#### Scenario: Create components from config
- **WHEN** `createBridgeComponents(config, deps)` is called
- **THEN** it SHALL return BridgeComponents object with all coordinators initialized

#### Scenario: Test can inject mocks
- **WHEN** test calls `createBridgeComponents` with mock deps
- **THEN** components SHALL use injected mocks instead of defaults

### Requirement: BridgeManager uses BridgeFactory
BridgeManager SHALL delegate component creation to BridgeFactory and focus on adapter lifecycle.

#### Scenario: Simplified BridgeManager constructor
- **WHEN** BridgeManager is constructed
- **THEN** it SHALL call `createBridgeComponents` and store result in single `components` field

### Requirement: AutomationBridge interface for automation consumers
AutomationBridge SHALL provide minimal interface for WebhookServer and CronScheduler.

#### Scenario: WebhookServer uses AutomationBridge
- **WHEN** WebhookServer needs to access bridge capabilities
- **THEN** it SHALL only depend on AutomationBridge interface methods

#### Scenario: CronScheduler uses AutomationBridge
- **WHEN** CronScheduler needs to inject automation prompts
- **THEN** it SHALL call `injectAutomationPrompt` via AutomationBridge

### Requirement: Eliminate forwarding methods
BridgeManager forwarding methods SHALL be removed; callers SHALL access components directly.

#### Scenario: Direct access to PermissionCoordinator
- **WHEN** HookNotificationDispatcher needs to track hook message
- **THEN** it SHALL call `permissions.hooks.trackHookMessage` directly

#### Scenario: Direct access to BridgeStore
- **WHEN** WebhookServer needs to get binding
- **THEN** it SHALL call `store.getBinding` directly (via AutomationBridge)