## MODIFIED Requirements

### Requirement: Single utils directory
All utility functions SHALL be located in src/utils/ directory.

#### Scenario: Engine utils merged
- **WHEN** the refactoring is complete
- **THEN** engine/utils/ directory SHALL NOT exist

#### Scenario: Utils files relocated
- **WHEN** engine/utils/router.ts, engine/utils/conversation.ts, and engine/utils/cost-tracker.ts are merged
- **THEN** they SHALL be located at src/utils/router.ts, src/utils/conversation.ts, and src/utils/cost-tracker.ts

### Requirement: Import paths updated
All import statements referencing engine/utils/ SHALL be updated to reference src/utils/.

#### Scenario: Engine imports updated
- **WHEN** a file imports from '../../../engine/utils/router'
- **THEN** the import SHALL be updated to the correct relative path to src/utils/router

#### Scenario: Test imports updated
- **WHEN** test files reference engine/utils/
- **THEN** imports SHALL be updated to src/utils/

#### Scenario: No broken imports
- **WHEN** TypeScript compilation is run
- **THEN** no import resolution errors SHALL occur