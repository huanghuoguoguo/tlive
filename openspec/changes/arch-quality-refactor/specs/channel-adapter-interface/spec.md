## ADDED Requirements

### Requirement: BaseChannelAdapter defines prepareBroadcast virtual method
BaseChannelAdapter SHALL define `prepareBroadcast(msg: RenderedMessage): BroadcastContext` as optional override.

#### Scenario: Default prepareBroadcast
- **WHEN** adapter does not override prepareBroadcast
- **THEN** default implementation SHALL return msg unchanged

### Requirement: BaseChannelAdapter defines classifyError virtual method
BaseChannelAdapter SHALL define `classifyError(err: unknown): BridgeError` as required override.

#### Scenario: Abstract method signature
- **WHEN** new adapter is implemented
- **THEN** it MUST implement classifyError method

### Requirement: Platform adapters implement new virtual methods
Each platform adapter SHALL implement prepareBroadcast and classifyError.

#### Scenario: FeishuAdapter.prepareBroadcast
- **WHEN** FeishuAdapter.prepareBroadcast is called
- **THEN** it SHALL add receive_id_type for group chat scenarios

#### Scenario: TelegramAdapter.classifyError
- **WHEN** TelegramAdapter.classifyError receives grammy error
- **THEN** it SHALL return RateLimitError for 429 status, PlatformError for others