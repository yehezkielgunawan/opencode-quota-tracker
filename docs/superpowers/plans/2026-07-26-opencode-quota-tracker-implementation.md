# OpenCode Cross-Provider Quota Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and package an OpenCode TUI plugin whose local `/quota` command reports OpenAI and Anthropic subscription allowance, official organization API accounting, and local OpenCode accounting without invoking a model.

**Architecture:** A TUI-only entry composes provider collectors behind a normalized domain model and a concurrent report service. Network, cache, credential, redaction, clock, and SQLite modules remain UI-independent; SQLite is selected at runtime as `bun:sqlite` inside OpenCode and `node:sqlite` under Node, with no native npm database dependency.

**Tech Stack:** pnpm 9.4.0, Node.js 22, TypeScript 5.9.3, Vitest 4.1.10, Babel 7 with `@babel/preset-typescript` and `babel-preset-solid`, Solid 1.9.12, OpenTUI 0.4.5, OpenCode plugin API 1.18.5

---

## File Map

- `src/domain/quota.ts`: normalized metrics, collector outcomes, and validation helpers.
- `src/domain/format.ts`: deterministic percentages, currency, tokens, and reset-time formatting.
- `src/report/http.ts`: allowlisted JSON HTTP requests, timeout mapping, and safe error conversion.
- `src/report/cache.ts`: five-minute success cache and stale fallback.
- `src/report/service.ts`: concurrent collector settlement and stable report ordering.
- `src/runtime/paths.ts`: OpenCode and Claude credential/database path candidates without `xdg-basedir`.
- `src/runtime/auth.ts`: OpenCode OAuth, Claude Code OAuth, and Admin environment-key discovery.
- `src/runtime/redact.ts`: recursive secret and account-identifier redaction.
- `src/runtime/sqlite.ts`: common read-only query contract with `bun:sqlite` and `node:sqlite` adapters.
- `src/collectors/opencode.ts`: local assistant-message aggregation.
- `src/collectors/openai-subscription.ts`: Codex consumer allowance collection.
- `src/collectors/openai-admin.ts`: OpenAI organization usage and cost collection.
- `src/collectors/anthropic-subscription.ts`: Claude consumer allowance collection.
- `src/collectors/anthropic-admin.ts`: Anthropic organization usage and cost collection.
- `src/tui.tsx`: `/quota` registration, lifecycle cleanup, and scrollable dialog.
- `tests/**/*.test.ts`: Node-based unit and collector tests with mocked fetch, clocks, credentials, and SQLite adapters.
- `tests/fixtures/**`: sanitized provider payloads and a SQL fixture builder.
- `scripts/build-tui.mjs`: Babel Solid universal transform for the TUI entry.

## Execution Rules

- Run each test once before implementation and confirm the expected failure.
- Implement only enough behavior for the current task, then run the focused test and `pnpm typecheck`.
- Never use live credentials or provider endpoints in the standard suite.
- Keep OpenAI subscription OAuth sourced from OpenCode and Anthropic subscription OAuth sourced from Claude Code's macOS Keychain or `~/.claude/.credentials.json`.
- Read Admin keys only from `OPENAI_ADMIN_API_KEY` and `ANTHROPIC_ADMIN_API_KEY`.
- Do not install Bun separately. OpenCode's host can provide `bun:sqlite`; Node 22 tests and standalone execution use `node:sqlite`.
- Do not add `better-sqlite3`, `xdg-basedir`, or another native runtime dependency.

### Task 1: Scaffold pnpm, TypeScript, Vitest, and Babel

**Files:**
- Create: `package.json`
- Create: `pnpm-lock.yaml`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `scripts/clean-dist.mjs`
- Create: `scripts/build-tui.mjs`
- Create: `src/scaffold.d.ts`
- Modify: `.gitignore`
- Modify: `docs/superpowers/specs/2026-07-26-opencode-cross-provider-quota-tracker-design.md`

- [ ] **Step 1: Pin the package contract**

Set `packageManager` to `pnpm@9.4.0`, Node to `>=22`, OpenCode to `>=1.18.0`, ESM exports to `./tui`, package files to `dist/`, `README.md`, and `LICENSE`, and `oc-plugin` to `["tui"]`. Keep host libraries in both peer dependencies and development dependencies, and keep runtime dependencies empty.

- [ ] **Step 2: Configure strict compilation and tests**

Use ES2022, ESM, bundler resolution, strict optional/index checks, declaration maps, source maps, preserved JSX, `jsxImportSource: "@opentui/solid"`, `rootDir: "src"`, and `outDir: "dist"`. Configure Vitest's Node environment for `tests/**/*.test.ts` and `tests/**/*.test.tsx`; use `vitest run --passWithNoTests` while the scaffold has no tests.

- [ ] **Step 3: Add deterministic build scripts**

Make `clean-dist.mjs` remove `dist` recursively. Make `build-tui.mjs` call Babel with:

```js
presets: [
  ["@babel/preset-typescript", { allExtensions: true, isTSX: true }],
  ["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }],
]
```

Emit `dist/tui.js` and `dist/tui.js.map`. If `src/tui.tsx` is absent, fail with a message that names the missing source and Task 10.

- [ ] **Step 4: Install and verify**

Run: `pnpm install`
Expected: dependencies install and `pnpm-lock.yaml` is created with pnpm 9.4 lockfile metadata.

Run: `pnpm typecheck`
Expected: exit 0.

Run: `pnpm test`
Expected: exit 0 with no test files found.

- [ ] **Step 5: Commit the scaffold**

```bash
git add .gitignore package.json pnpm-lock.yaml tsconfig.json vitest.config.ts scripts src/scaffold.d.ts docs/superpowers
git commit -m "chore: scaffold pnpm plugin"
```

### Task 2: Define the Domain Model and Formatting Contract

**Files:**
- Create: `src/domain/quota.ts`
- Create: `src/domain/format.ts`
- Create: `tests/domain/quota.test.ts`
- Create: `tests/domain/format.test.ts`
- Delete: `src/scaffold.d.ts`

- [ ] **Step 1: Write normalized-model tests**

Cover valid allowance, token, and cost metrics; reject mismatched units, non-finite values, negative token/cost values, and allowance records without usable percent data. Verify used percent clamps to zero through 100 and remaining is derived as `100 - used` only when absent.

```ts
expect(normalizeAllowance({ used: 118 })).toEqual({ used: 100, remaining: 0, limit: 100 })
expect(normalizeAllowance({ used: -3 })).toEqual({ used: 0, remaining: 100, limit: 100 })
```

- [ ] **Step 2: Run the tests and confirm failure**

Run: `pnpm vitest run tests/domain/quota.test.ts tests/domain/format.test.ts`
Expected: FAIL because `src/domain/quota.ts` and `src/domain/format.ts` do not exist.

- [ ] **Step 3: Implement the shared types**

Define `Provider`, `AccountKind`, `MetricKind`, `Authority`, `Acquisition`, `QuotaMetric`, `CollectorState`, `CollectorOutcome`, `Collector`, `QuotaSection`, and `QuotaReport`. Export constructors that validate each discriminated metric variant rather than accepting arbitrary combinations.

- [ ] **Step 4: Implement deterministic formatting**

Use `Intl.NumberFormat("en-US")` for integer tokens, a fixed USD formatter for costs, and an injected `now` value for reset countdowns. Expired reset timestamps render `now`; future timestamps render the largest meaningful day/hour/minute pair.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run tests/domain/quota.test.ts tests/domain/format.test.ts && pnpm typecheck`
Expected: all tests pass and typecheck exits 0.

```bash
git add src/domain tests/domain src/scaffold.d.ts
git commit -m "feat: add quota domain model"
```

### Task 3: Add HTTP, Cache, and Concurrent Report Infrastructure

**Files:**
- Create: `src/report/http.ts`
- Create: `src/report/cache.ts`
- Create: `src/report/service.ts`
- Create: `tests/report/http.test.ts`
- Create: `tests/report/cache.test.ts`
- Create: `tests/report/service.test.ts`

- [ ] **Step 1: Test bounded HTTP behavior**

Use a mocked `fetch` and fake timers to assert HTTPS-only allowlisted hosts, five-second aborts, JSON content handling, mappings for 401/403/429, and `unsupported_response` for malformed JSON. Assert safe errors never include request headers or response bodies.

- [ ] **Step 2: Test cache and stale behavior**

With an injected clock, prove a successful value is fresh for five minutes, expired success causes a refresh, and a transient refresh failure can return the prior success as `stale` with its original `fetchedAt`.

- [ ] **Step 3: Test report settlement**

Create collectors that resolve, reject, time out, and return `not_configured`. Assert they start before any result is awaited, one rejection does not hide successful results, and ordering is subscription, API organization, local; then OpenAI, Anthropic, OpenCode.

- [ ] **Step 4: Run the tests and confirm failure**

Run: `pnpm vitest run tests/report`
Expected: FAIL because the report infrastructure modules do not exist.

- [ ] **Step 5: Implement the minimal infrastructure**

Export `requestJson`, `SuccessCache`, and `QuotaReportService`. Require network collectors to pass an explicit host allowlist. Use `AbortSignal.timeout(5_000)` and `Promise.allSettled`; convert thrown collector errors to isolated `unavailable` outcomes.

- [ ] **Step 6: Verify and commit**

Run: `pnpm vitest run tests/report && pnpm typecheck`
Expected: all tests pass and typecheck exits 0.

```bash
git add src/report tests/report
git commit -m "feat: add report infrastructure"
```

### Task 4: Add Runtime Paths, Authentication, SQLite Selection, and Redaction

**Files:**
- Create: `src/runtime/paths.ts`
- Create: `src/runtime/auth.ts`
- Create: `src/runtime/sqlite.ts`
- Create: `src/runtime/redact.ts`
- Create: `tests/runtime/paths.test.ts`
- Create: `tests/runtime/auth.test.ts`
- Create: `tests/runtime/sqlite.test.ts`
- Create: `tests/runtime/redact.test.ts`

- [ ] **Step 1: Test platform path candidates**

Inject `platform`, `homedir`, and environment values. Assert macOS, Linux, and Windows OpenCode data candidates and the exact Claude fallback `~/.claude/.credentials.json`. Keep path construction in Node core modules and do not depend on `xdg-basedir`.

- [ ] **Step 2: Test credential precedence and parsing**

Assert OpenAI subscription auth comes from OpenCode OAuth, Anthropic subscription auth first tries the macOS Keychain reader and then Claude's credentials JSON, and Admin keys come only from their two documented environment variables. Empty, malformed, and expired credentials return `not_configured` or `unauthorized` without token fragments.

- [ ] **Step 3: Test recursive redaction**

Cover bearer headers, raw known secrets, query parameters, nested objects, error causes, emails, and provider account identifiers. Preserve harmless status codes and field names while replacing values with `[REDACTED]` or a stable masked display form.

- [ ] **Step 4: Test runtime SQLite selection**

Inject module loaders and assert a Bun-like host selects `bun:sqlite`, Node selects `node:sqlite`, both open read-only, and both expose the same `all(sql, params)` and `close()` contract. No test imports `bun:sqlite` eagerly.

- [ ] **Step 5: Run the tests and confirm failure**

Run: `pnpm vitest run tests/runtime`
Expected: FAIL because the runtime modules do not exist.

- [ ] **Step 6: Implement runtime boundaries**

Use dynamic imports only inside adapter factories:

```ts
const specifier = typeof globalThis.Bun === "object" ? "bun:sqlite" : "node:sqlite"
```

Hide host-specific statement APIs behind the common read-only interface. Execute macOS `security find-generic-password -s "Claude Code-credentials" -w` through an injected command runner and parse `claudeAiOauth.accessToken` from either source.

- [ ] **Step 7: Verify and commit**

Run: `pnpm vitest run tests/runtime && pnpm typecheck`
Expected: all tests pass and typecheck exits 0.

```bash
git add src/runtime tests/runtime
git commit -m "feat: add runtime security boundaries"
```

### Task 5: Implement Local OpenCode Accounting

**Files:**
- Create: `src/collectors/opencode.ts`
- Create: `tests/collectors/opencode.test.ts`
- Create: `tests/fixtures/opencode-schema.ts`

- [ ] **Step 1: Write read-only aggregation tests**

Build an in-memory `node:sqlite` fixture matching the OpenCode message/session shape. Include completed and incomplete assistant messages, user messages, multiple models/providers, UTC boundary timestamps, token subfields, and recorded costs.

- [ ] **Step 2: Assert day and month semantics**

Verify current UTC day and current UTC calendar month totals, provider/model grouping, exclusion of incomplete assistant messages, and direct summation of OpenCode-recorded token and cost values. Assert the adapter receives only read queries.

- [ ] **Step 3: Run the focused test and confirm failure**

Run: `pnpm vitest run tests/collectors/opencode.test.ts`
Expected: FAIL because `OpenCodeUsageCollector` does not exist.

- [ ] **Step 4: Implement the collector**

Locate the first existing `opencode.db` candidate, open it read-only through `src/runtime/sqlite.ts`, inspect the supported schema version, and execute parameterized UTC-range queries. Return separate token and recorded-cost metrics with `authority: "local_record"` and `acquisition: "local_database"`.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run tests/collectors/opencode.test.ts && pnpm typecheck`
Expected: all tests pass and typecheck exits 0.

```bash
git add src/collectors/opencode.ts tests/collectors/opencode.test.ts tests/fixtures/opencode-schema.ts
git commit -m "feat: collect local OpenCode usage"
```

### Task 6: Implement OpenAI Subscription Allowance

**Files:**
- Create: `src/collectors/openai-subscription.ts`
- Create: `tests/collectors/openai-subscription.test.ts`
- Create: `tests/fixtures/openai-subscription.json`

- [ ] **Step 1: Test credential and request behavior**

Assert the collector uses only OpenCode's OpenAI OAuth token, sends it only to the allowlisted OpenAI consumer host, never accepts `OPENAI_API_KEY` as subscription auth, and returns `not_configured` when compatible OAuth is absent.

- [ ] **Step 2: Test payload normalization**

Cover one and multiple rate-limit windows, duration metadata, used percent, missing optional fields, clamping, reset timestamps, unauthorized/rate-limited responses, and a changed payload shape. Window labels must derive from provider duration metadata rather than fixed five-hour/weekly assumptions.

- [ ] **Step 3: Run the focused test and confirm failure**

Run: `pnpm vitest run tests/collectors/openai-subscription.test.ts`
Expected: FAIL because `OpenAISubscriptionCollector` does not exist.

- [ ] **Step 4: Implement the collector**

Call the Codex consumer usage endpoint through `requestJson`, validate unknown JSON with explicit type guards, and emit one allowance metric per valid window with `authority: "provider_reported"` and `acquisition: "consumer_api"`. Empty or ambiguous windows return `unsupported_response`, never zero usage.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run tests/collectors/openai-subscription.test.ts && pnpm typecheck`
Expected: all tests pass and typecheck exits 0.

```bash
git add src/collectors/openai-subscription.ts tests/collectors/openai-subscription.test.ts tests/fixtures/openai-subscription.json
git commit -m "feat: collect OpenAI subscription allowance"
```

### Task 7: Implement OpenAI Admin Usage and Cost

**Files:**
- Create: `src/collectors/openai-admin.ts`
- Create: `tests/collectors/openai-admin.test.ts`
- Create: `tests/fixtures/openai-admin-usage.json`
- Create: `tests/fixtures/openai-admin-costs.json`

- [ ] **Step 1: Test Admin-key gating and UTC ranges**

Assert only `OPENAI_ADMIN_API_KEY` enables this collector. Verify month start and current time are sent as UTC epoch boundaries, an ordinary unauthorized key maps to `unauthorized`, and missing configuration does not affect subscription collection.

- [ ] **Step 2: Test pagination and separation**

Provide two usage pages and two cost pages with cursor transitions. Assert every page is requested once, input/output/cache/reasoning token values are summed without double counting, and monetary cost remains a separate metric.

- [ ] **Step 3: Run the focused test and confirm failure**

Run: `pnpm vitest run tests/collectors/openai-admin.test.ts`
Expected: FAIL because `OpenAIApiCollector` does not exist.

- [ ] **Step 4: Implement the collector**

Request official organization completions usage and costs endpoints through the allowlisted HTTP module. Validate each page before following its cursor and emit authoritative month-to-date token and USD metrics; reject missing buckets or currency ambiguity as `unsupported_response`.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run tests/collectors/openai-admin.test.ts && pnpm typecheck`
Expected: all tests pass and typecheck exits 0.

```bash
git add src/collectors/openai-admin.ts tests/collectors/openai-admin.test.ts tests/fixtures/openai-admin-usage.json tests/fixtures/openai-admin-costs.json
git commit -m "feat: collect OpenAI Admin accounting"
```

### Task 8: Implement Anthropic Subscription Allowance

**Files:**
- Create: `src/collectors/anthropic-subscription.ts`
- Create: `tests/collectors/anthropic-subscription.test.ts`
- Create: `tests/fixtures/anthropic-subscription.json`

- [ ] **Step 1: Test Claude Code credential sources**

Assert macOS Keychain wins over the JSON fallback, non-macOS reads `~/.claude/.credentials.json`, and OpenCode Anthropic OAuth is never queried. Verify expired or malformed Claude OAuth cannot become an Authorization header.

- [ ] **Step 2: Test volatile consumer payloads**

Cover all supported allowance-window response variants, provider reset periods, used-versus-remaining semantics, null windows, unauthorized/rate-limited responses, and unknown structures. Assert no fixed calendar period is inferred.

- [ ] **Step 3: Run the focused test and confirm failure**

Run: `pnpm vitest run tests/collectors/anthropic-subscription.test.ts`
Expected: FAIL because `AnthropicSubscriptionCollector` does not exist.

- [ ] **Step 4: Implement the collector**

Use the Claude Code OAuth loader and allowlisted Anthropic consumer endpoint. Runtime-validate the response and return provider-reported consumer allowance metrics; isolate schema changes as `unsupported_response` and redact account data before logging.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run tests/collectors/anthropic-subscription.test.ts && pnpm typecheck`
Expected: all tests pass and typecheck exits 0.

```bash
git add src/collectors/anthropic-subscription.ts tests/collectors/anthropic-subscription.test.ts tests/fixtures/anthropic-subscription.json
git commit -m "feat: collect Anthropic subscription allowance"
```

### Task 9: Implement Anthropic Admin Usage and Cost

**Files:**
- Create: `src/collectors/anthropic-admin.ts`
- Create: `tests/collectors/anthropic-admin.test.ts`
- Create: `tests/fixtures/anthropic-admin-usage.json`
- Create: `tests/fixtures/anthropic-admin-cost.json`

- [ ] **Step 1: Test Admin-key and account behavior**

Assert only `ANTHROPIC_ADMIN_API_KEY` enables this collector. Cover unsupported individual accounts, permission failures, absent credentials, UTC month boundaries, and the required Admin API request headers.

- [ ] **Step 2: Test pagination and metric separation**

Use multiple message-usage and cost pages. Assert all input/output/cache token categories are summed, cursors terminate correctly, currency is validated, and tokens and cost remain distinct records.

- [ ] **Step 3: Run the focused test and confirm failure**

Run: `pnpm vitest run tests/collectors/anthropic-admin.test.ts`
Expected: FAIL because `AnthropicApiCollector` does not exist.

- [ ] **Step 4: Implement the collector**

Call Anthropic's official Usage and Cost Admin endpoints through `requestJson`, passing month-to-date ISO UTC bounds. Validate every page before accumulation and map unsupported individual accounts to `unavailable` rather than zero-valued metrics.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run tests/collectors/anthropic-admin.test.ts && pnpm typecheck`
Expected: all tests pass and typecheck exits 0.

```bash
git add src/collectors/anthropic-admin.ts tests/collectors/anthropic-admin.test.ts tests/fixtures/anthropic-admin-usage.json tests/fixtures/anthropic-admin-cost.json
git commit -m "feat: collect Anthropic Admin accounting"
```

### Task 10: Build the TUI `/quota` Command

**Files:**
- Create: `src/tui.tsx`
- Create: `src/tui/report-view.tsx`
- Create: `tests/tui/quota-command.test.tsx`
- Create: `tests/tui/report-view.test.tsx`

- [ ] **Step 1: Test command registration and lifecycle**

Mock the OpenCode TUI API and assert one keymap layer registers `/quota`, execution opens a local dialog, no prompt is submitted, no model method is called, a second invocation refreshes expired data, and plugin cleanup removes the layer and dialog resources.

- [ ] **Step 2: Test report rendering states**

Render loading, complete, partial-failure, all-unavailable, stale, and missing-Admin-key reports. Assert the three account-kind sections, source/freshness labels, setup hints, reset countdowns, scroll container, and per-provider isolation.

- [ ] **Step 3: Run the focused tests and confirm failure**

Run: `pnpm vitest run tests/tui`
Expected: FAIL because the TUI entry and report view do not exist.

- [ ] **Step 4: Compose collectors and register `/quota`**

Create the five collectors with shared HTTP/cache/runtime dependencies, pass them to `QuotaReportService`, and register a deterministic no-argument command through `api.keymap.registerLayer(...)`. Render Solid components with OpenTUI primitives and keep all network/database work outside JSX components.

- [ ] **Step 5: Verify transformed output**

Run: `pnpm vitest run tests/tui && pnpm typecheck && pnpm build`
Expected: tests pass; Babel emits `dist/tui.js` and its map; TypeScript emits declarations including `dist/tui.d.ts`.

- [ ] **Step 6: Commit the TUI**

```bash
git add src/tui.tsx src/tui tests/tui
git commit -m "feat: add quota TUI command"
```

### Task 11: Complete Documentation and Package Verification

**Files:**
- Create: `README.md`
- Create: `LICENSE`
- Modify: `package.json`
- Modify: `docs/superpowers/specs/2026-07-26-opencode-cross-provider-quota-tracker-design.md`

- [ ] **Step 1: Document installation and credential authority**

Document pnpm/npm installation, the `opencode-quota-tracker/tui` entry, `/quota`, supported accounting categories, OpenCode OAuth for OpenAI subscription, Claude Code Keychain/file OAuth for Anthropic subscription, both Admin environment variables, cache freshness, read-only local data, and known consumer-endpoint volatility.

- [ ] **Step 2: Document runtime and privacy constraints**

State Node 22 and OpenCode 1.18 minimums, explain automatic `bun:sqlite` versus `node:sqlite` selection, and state that no OAuth/Admin secret, historical snapshot, or plugin-owned database is persisted.

- [ ] **Step 3: Run the complete verification suite**

Run: `pnpm check`
Expected: typecheck, all Vitest tests, and production build pass.

Run: `pnpm pack --dry-run`
Expected: the package contains `dist/`, `README.md`, `LICENSE`, and package metadata, with no source tests, credentials, fixture data, coverage, or local database.

- [ ] **Step 4: Inspect the built entry**

Run: `node -e "import('./dist/tui.js').then((m) => { if (!m.default) process.exit(1) })"`
Expected: exit 0 and no collector runs during module import.

- [ ] **Step 5: Perform a secret and dependency audit**

Run: `pnpm list --prod --depth Infinity`
Expected: no `better-sqlite3`, `xdg-basedir`, or other native runtime package.

Search tracked files for bearer tokens, realistic API-key prefixes, `.credentials.json` contents, and database files. Expected: only documentation names and sanitized fixtures are present.

- [ ] **Step 6: Commit release-ready packaging**

```bash
git add README.md LICENSE package.json docs/superpowers/specs
git commit -m "docs: document quota tracker setup"
```
