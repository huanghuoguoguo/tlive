## ADDED Requirements

### Requirement: Feishu formatter modules exist
The system SHALL organize Feishu message formatting into separate module files by message domain.

#### Scenario: Formatter files created
- **WHEN** the refactoring is complete
- **THEN** the following files SHALL exist in channels/feishu/:
  - format-home.ts (home message formatting)
  - format-permission.ts (permission flow formatting)
  - format-progress.ts (progress indication formatting)
  - formatter.ts (router/dispatch only)

### Requirement: Main formatter delegates to modules
The main formatter.ts SHALL delegate formatting to domain-specific modules rather than containing inline switch-case logic.

#### Scenario: Home message formatting delegation
- **WHEN** formatHome() is called
- **THEN** the call SHALL be delegated to format-home.ts

#### Scenario: Permission message formatting delegation
- **WHEN** formatPermission() is called
- **THEN** the call SHALL be delegated to format-permission.ts

#### Scenario: Progress message formatting delegation
- **WHEN** formatProgress() is called
- **THEN** the call SHALL be delegated to format-progress.ts

### Requirement: No circular dependencies in formatter modules
The formatter modules SHALL NOT have circular dependencies with each other.

#### Scenario: Circular dependency check
- **WHEN** madge is run on the formatter files
- **THEN** no circular dependencies SHALL be detected