# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the TypeScript bridge runtime. Key areas are `channels/` for Telegram/Feishu/QQ Bot adapters, `engine/` for conversation and routing orchestration, `providers/` for Claude integration, and `formatting/`, `markdown/`, `store/`, and `utils/` for shared infrastructure. Unit tests live in `src/__tests__/` using `*.test.ts` names. Build output goes to `dist/` and should not be edited manually. Shell and Node helpers live in `scripts/`. User-facing docs live in `docs/`, and configuration starts from `config.env.example`.

## Build, Test, and Development Commands
Use Node.js 20+; CI runs on Node 20.x and 22.x.

- `npm run build` bundles the bridge into `dist/main.mjs` with esbuild.
- `npm run build:watch` rebuilds on `src/**/*.ts` changes.
- `npm run dev` rebuilds and starts the local bridge with `nodemon` (recommended for development).
- `npm start` builds, then runs the bridge with `TL_RUNTIME=claude`.
- `npm run typecheck` runs strict TypeScript checks.
- `npm run lint` runs Biome linting.
- `npm run format` formats `src/` and `esbuild.config.js`.
- `npm test` runs the Vitest suite once; `npm run test:watch` stays interactive.
- `npm run check` is the pre-PR sanity pass: typecheck, lint, and tests.

## Coding Style & Naming Conventions
Follow `.editorconfig` and `biome.json`: 2-space indentation, LF endings, UTF-8, single quotes, semicolons, and a 100-column line width. Keep TypeScript in strict mode and prefer explicit, narrow types at module boundaries. Use `kebab-case` for filenames (`message-renderer.ts`), `PascalCase` for classes, and `camelCase` for functions and variables. Preserve the existing `*.js` import suffixes in TypeScript files.

## Testing Guidelines
Write Vitest unit tests in `src/__tests__/` with names like `gateway.test.ts`. Add or update tests for behavior changes in adapters, engine flow, formatting, and config parsing. There is no published coverage threshold, so use targeted assertions around regressions and edge cases.

## Commit & Pull Request Guidelines
Recent history uses Conventional Commits such as `fix: ...`, `feat: ...`, `refactor: ...`, and `chore: ...`; optional scopes are fine when they add clarity. Keep subjects imperative and concise. PRs should explain what changed and why, list validation steps, and link the relevant issue when applicable. Include screenshots or message samples for channel UI/card formatting changes.

## Configuration & Security Tips
Do not commit real tokens or chat IDs. Start from `config.env.example`, copy it to `~/.tlive/config.env`, and keep permissions tight (`chmod 600`). When changing startup or packaging behavior, verify `scripts/`, `install.sh`, and release workflow expectations still match `dist/`.
