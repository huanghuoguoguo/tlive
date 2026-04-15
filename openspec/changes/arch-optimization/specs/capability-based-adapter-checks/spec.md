## ADDED Requirements

### Requirement: Adapter capability methods
The BaseChannelAdapter SHALL provide capability methods that allow runtime detection of platform-specific features.

#### Scenario: Supports pairing capability
- **WHEN** adapter.supportsPairing() is called
- **THEN** it SHALL return true for Telegram adapter and false for other adapters

#### Scenario: Supports streaming capability
- **WHEN** adapter.supportsStreaming() is called
- **THEN** it SHALL return true for adapters that support streaming responses

### Requirement: No hard-coded platform type checks
The codebase SHALL NOT contain hard-coded platform type checks like `adapter.channelType === 'telegram'`.

#### Scenario: Platform check replaced
- **WHEN** bridge-manager.ts needs to check if pairing is supported
- **THEN** it SHALL use adapter.supportsPairing() instead of channelType comparison

#### Scenario: Grep verification
- **WHEN** searching for channelType === pattern
- **THEN** no hard-coded comparisons SHALL exist in business logic files