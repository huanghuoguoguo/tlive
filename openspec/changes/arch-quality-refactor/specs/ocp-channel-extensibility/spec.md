## ADDED Requirements

### Requirement: BaseChannelAdapter.prepareBroadcast handles platform-specific broadcast
BaseChannelAdapter SHALL provide virtual method for platform-specific broadcast preparation.

#### Scenario: Feishu broadcast preparation
- **WHEN** broadcasting to Feishu channel
- **THEN** FeishuAdapter.prepareBroadcast SHALL set receive_id_type for group chats

#### Scenario: Telegram broadcast preparation
- **WHEN** broadcasting to Telegram channel
- **THEN** TelegramAdapter.prepareBroadcast SHALL return context without special fields

### Requirement: Engine no longer references platform-specific types
Engine code SHALL NOT directly import or reference platform-specific RenderedMessage types.

#### Scenario: Remove FeishuRenderedMessage import
- **WHEN** BridgeManager broadcasts message
- **THEN** it SHALL use adapter.prepareBroadcast instead of `if (channelType === 'feishu')` check

### Requirement: BaseChannelAdapter.classifyError handles platform errors
BaseChannelAdapter SHALL provide virtual method for platform-specific error classification.

#### Scenario: Default error classification
- **WHEN** adapter.classifyError is called with network error
- **THEN** default implementation SHALL return appropriate BridgeError subclass

#### Scenario: Platform-specific error classification
- **WHEN** FeishuAdapter.classifyError receives Feishu SDK error
- **THEN** it SHALL parse Feishu error format and return PlatformError with details

### Requirement: classifyError switch removed from channels/errors.ts
The `classifyError(channel, err)` function in channels/errors.ts SHALL be deprecated.

#### Scenario: Callers use adapter method
- **WHEN** code needs to classify error
- **THEN** it SHALL call `adapter.classifyError(err)` instead of `classifyError(channel, err)`