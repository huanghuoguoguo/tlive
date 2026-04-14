## ADDED Requirements

### Requirement: QueryContext encapsulates query execution parameters
QueryContext SHALL bundle all parameters needed for query execution into a single object.

#### Scenario: Construct QueryContext
- **WHEN** QueryOrchestrator prepares to execute query
- **THEN** it SHALL construct QueryContext with adapter, message, binding, sessionKey, renderer, handlers

#### Scenario: Access parameters via QueryContext
- **WHEN** executeQuery method runs
- **THEN** it SHALL access all needed parameters via `ctx.adapter`, `ctx.msg`, `ctx.binding`, etc.

### Requirement: QueryOrchestrator.executeQuery accepts single QueryContext
QueryOrchestrator.executeQuery SHALL accept QueryContext as single parameter instead of 10 individual parameters.

#### Scenario: Simplified executeQuery signature
- **WHEN** calling executeQuery
- **THEN** signature SHALL be `executeQuery(ctx: QueryContext)` instead of 10 positional parameters

### Requirement: QueryContext includes renderer creation
QueryContext SHALL optionally include MessageRenderer creation logic.

#### Scenario: Renderer in QueryContext
- **WHEN** QueryContext is constructed
- **THEN** it MAY include pre-configured MessageRenderer