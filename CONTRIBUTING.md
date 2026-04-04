# Contributing to tlive

Thanks for your interest in contributing! All contributions are welcome — bug reports, feature requests, docs improvements, and code.

Check [open issues](https://github.com/huanghuoguoguo/tlive/issues) for things to work on, or open a new one to start a discussion.

## Development Setup

**Prerequisites:** Go 1.24+, Node.js 18+, npm

```bash
git clone https://github.com/huanghuoguoguo/tlive.git
cd tlive
```

**Build Go Core:**

```bash
cd core
go build -o tlive ./cmd/tlive/
```

**Build Node.js Bridge:**

```bash
cd bridge
npm ci
npm run build
```

## Project Structure

| Directory   | Description                                |
|-------------|--------------------------------------------|
| `core/`     | Go core — main application binary          |
| `bridge/`   | Node.js bridge — TypeScript, built with npm |
| `scripts/`  | CLI entry point + hook scripts (Node.js)   |
| `.github/`  | CI workflows (GitHub Actions)              |

## Running Tests

**Go Core:**

```bash
cd core
go test ./...
```

**Node.js Bridge:**

```bash
cd bridge
npm test
```

## Code Style

- **Go:** Use `gofmt`. No additional linter configuration needed.
- **TypeScript (Bridge):** Follow existing patterns in the codebase. No special formatter is enforced beyond what the project already uses.

## Submitting Changes

1. Fork the repo and create a branch from `main`.
2. Make your changes and add tests if applicable.
3. Use conventional commit messages: `type(scope): message`
   - Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`
   - Scope: `core`, `bridge`, `scripts`, or omit for cross-cutting changes
   - Example: `fix(bridge): handle empty response from core`
4. Open a pull request against `main`. Describe what changed and why.
5. Ensure CI passes before requesting review.

## Reporting Bugs

Open an issue using the bug report template. Include:

- Steps to reproduce
- Expected vs actual behavior
- OS, Go version, Node.js version

## Feature Requests

Open an issue using the feature request template. Describe the use case and why it would be valuable.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
