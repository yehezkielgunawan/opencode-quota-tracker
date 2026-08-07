# Repository Instructions

## Context

- This is a single-package ESM TypeScript OpenCode TUI plugin, not a monorepo. The source entrypoint is `src/tui.tsx`; the published package exposes only `./tui` and must default-export `{ tui }`.
- `/quota` discovery depends on the registered command staying `name: "quota.show"`, `namespace: "palette"`, and `slashName: "quota"`.
- `src/collectors/` adapts provider and local sources; `src/domain/` owns normalized quota types and validation; `src/report/` owns bounded collection, ordering, grouping, and caching; `src/runtime/` owns platform paths, credentials, and read-only SQLite; `src/tui/` renders the report dialog.
- No repository-local `AGENTS.md`, `CLAUDE.md`, OpenCode config, CI workflow, linter, or formatter was present when this file was created. Higher-level instructions still apply.

## Toolchain And Commands

- Use Node.js `>=22.12.0` and pnpm `9.4.0`; `pnpm-lock.yaml` is the dependency source of truth.
- Install dependencies with `pnpm install`.
- Run `pnpm check` before completion. It intentionally runs `typecheck -> test -> build` in that order.
- Run a focused test with `pnpm exec vitest run tests/tui/quota-command.test.tsx` or another path under `tests/`.
- `pnpm build` deletes and recreates ignored `dist/`; TypeScript emits declarations and `scripts/build-tui.mjs` then transforms TSX with Babel/OpenTUI Solid. Edit `src/` and build scripts, never generated `dist/` files.
- Use `npm pack --dry-run` to inspect publish contents. The package publishes only `dist/`, `README.md`, and `LICENSE`; `scripts/verify-package.mjs` requires the `./tui` JavaScript and type targets to exist.

## Runtime Constraints

- `OPENAI_ADMIN_API_KEY` and `ANTHROPIC_ADMIN_API_KEY` are the only Admin API credentials. Subscription data uses OpenAI's OpenCode OAuth and Anthropic's Claude Code OAuth; inference API keys are not substitutes.
- Preserve per-collector states such as `not_configured`, `unauthorized`, `timeout`, `unsupported_response`, and `stale`; never turn missing or failed provider data into zero usage.
- OpenCode's database is opened read-only. Do not add migrations, writes, replacement databases, or persisted quota history.
- When testing a newly published release, refresh a stale OpenCode cache with `opencode plugin opencode-quota-tracker@<version> --global --force`, then restart the TUI. A bare cached install can continue using an older artifact.

## Testing And Files

- Vitest runs in Node and pre-transforms `.tsx` through the custom Babel/OpenTUI Solid plugin in `vitest.config.ts`; preserve that setup when changing TUI tests.
- Tests use deterministic fixtures under `tests/fixtures` and injected clocks, services, HTTP, auth, and SQLite loaders. Extend those seams instead of using live provider credentials or APIs.
- `docs/` is intentionally ignored by `.gitignore`; do not assume files created there will appear in a commit.
