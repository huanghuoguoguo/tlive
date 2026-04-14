## ADDED Requirements

### Requirement: HomePayloadBuilder extracts buildHomePayload logic
HomePayloadBuilder SHALL encapsulate the home payload construction logic from CommandRouter.

#### Scenario: Build home payload
- **WHEN** CommandRouter needs to display home screen
- **THEN** it SHALL delegate to HomePayloadBuilder.build(channelType, chatId)

#### Scenario: HomePayloadBuilder dependencies
- **WHEN** HomePayloadBuilder is constructed
- **THEN** it SHALL receive store, state, workspace, permissions, sdkEngine, and other needed components

### Requirement: Format utilities moved to session-format.ts
Session formatting utilities SHALL be moved to engine/utils/session-format.ts.

#### Scenario: formatSessionDate moved
- **WHEN** HomePayloadBuilder formats session dates
- **THEN** it SHALL use formatSessionDate from engine/utils/session-format.ts

#### Scenario: formatRelativeTime moved
- **WHEN** HomePayloadBuilder formats relative times
- **THEN** it SHALL use formatRelativeTime from engine/utils/session-format.ts

### Requirement: CommandRouter constructor simplified
CommandRouter constructor SHALL accept fewer parameters after HomePayloadBuilder extraction.

#### Scenario: CommandRouter dependencies
- **WHEN** CommandRouter is constructed
- **THEN** it SHALL receive HomePayloadBuilder and CommandServices only