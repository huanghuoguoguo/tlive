# Contributing to tlive

Thanks for your interest in contributing! All contributions are welcome — bug reports, feature requests, docs improvements, and code.

Check [open issues](https://github.com/huanghuoguoguo/tlive/issues) for things to work on, or open a new one to start a discussion.

## Development Setup

**Prerequisites:** Node.js 20+, npm

```bash
git clone https://github.com/huanghuoguoguo/tlive.git
cd tlive
npm ci
```

## Project Structure

| Directory   | Description                                |
|-------------|--------------------------------------------|
| `src/`      | TypeScript source — Bridge service, IM adapters |
| `scripts/`  | CLI entry point + hook scripts (Node.js)   |
| `docs/`     | User documentation                         |
| `.claude/`  | Claude Code skills and references          |
| `.github/`  | CI workflows (GitHub Actions)              |

## Running Tests

```bash
npm test
```

## Build

```bash
npm run build
```

## Development

```bash
npm run dev        # Watch mode, auto-rebuild
npm run dev:hot    # Hot reload: rebuild + auto-restart
npm start          # Build and start bridge (for manual testing)
```

## Code Style

- **TypeScript:** Follow existing patterns in the codebase
- Use conventional commit messages: `type(scope): message`
  - Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`
  - Scope: `bridge`, `feishu`, `telegram`, `qqbot`, `scripts`, or omit for cross-cutting changes
  - Example: `fix(feishu): handle card callback timeout`

## Submitting Changes

1. Fork the repo and create a branch from `main`.
2. Make your changes and add tests if applicable.
3. Open a pull request against `main`. Describe what changed and why.
4. Ensure CI passes before requesting review.

## Reporting Bugs

Open an issue using the bug report template. Include:

- Steps to reproduce
- Expected vs actual behavior
- OS, Node.js version
- Relevant log output (`tlive logs`)

## Feature Requests

Open an issue using the feature request template. Describe the use case and why it would be valuable.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).