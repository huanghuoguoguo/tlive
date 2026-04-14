## ADDED Requirements

### Requirement: PermissionCoordinator facade delegates to sub-components
PermissionCoordinator SHALL delegate all permission operations to specialized sub-components while maintaining backward-compatible API signatures.

#### Scenario: Facade API compatibility
- **WHEN** existing code calls PermissionCoordinator methods (e.g., `trackHookMessage`, `storeQuestionData`)
- **THEN** the facade SHALL delegate to appropriate sub-component without changing method signature

#### Scenario: Sub-component access
- **WHEN** code needs fine-grained permission control
- **THEN** PermissionCoordinator SHALL expose sub-components via getters (`sdk`, `hooks`, `questions`, `whitelist`)

### Requirement: SdkPermTracker handles SDK permission lifecycle
SdkPermTracker SHALL manage pending SDK permissions and text-based approval routing.

#### Scenario: Track pending SDK permission
- **WHEN** SDK requests permission for a chat
- **THEN** SdkPermTracker SHALL store pending permission with request ID

#### Scenario: Resolve by text approval
- **WHEN** user sends approval text message
- **THEN** SdkPermTracker SHALL attempt to match and resolve pending permission

### Requirement: HookResolver manages hook deduplication and callbacks
HookResolver SHALL prevent duplicate hook processing and manage callback resolution.

#### Scenario: Deduplicate hook messages
- **WHEN** same hook ID is received multiple times
- **THEN** HookResolver SHALL track resolved hook IDs and skip duplicates

#### Scenario: Resolve hook callback
- **WHEN** user approves/rejects hook permission via callback
- **THEN** HookResolver SHALL invoke stored callback with decision

### Requirement: QuestionResolver handles AskUserQuestion flow
QuestionResolver SHALL manage multi-select toggles and question resolution.

#### Scenario: Store question data
- **WHEN** SDK sends AskUserQuestion request
- **THEN** QuestionResolver SHALL store question data with options

#### Scenario: Toggle multi-select option
- **WHEN** user toggles an option in multi-select question
- **THEN** QuestionResolver SHALL track toggled selections

### Requirement: SessionWhitelist manages dynamic tool permissions
SessionWhitelist SHALL track per-session allowed tools and bash prefixes.

#### Scenario: Allow tool for session
- **WHEN** user approves tool usage for current session
- **THEN** SessionWhitelist SHALL add tool to allowed set for that session

#### Scenario: Check bash prefix allowance
- **WHEN** SDK requests bash command execution
- **THEN** SessionWhitelist SHALL check if command prefix is allowed