# OpenCode Cross-Provider Quota Tracker Design

Date: 2026-07-26
Status: Implemented for the v0.1.0 package release
Working package name: `opencode-quota-tracker`

The implementation is available through the `opencode-quota-tracker/tui`
package export. Install it through OpenCode's npm plugin configuration, then
run `/quota` in the TUI. The end-user setup, credential sources, report layout,
privacy boundaries, and troubleshooting steps are documented in `README.md`.

## Summary

Build a publishable OpenCode TUI plugin that registers a deterministic `/quota`
slash command. The command displays three kinds of accounting without combining
them:

1. Consumer subscription allowance windows for OpenAI and Anthropic.
2. Organization API usage and cost from official provider Admin APIs.
3. Token usage and recorded cost from the local OpenCode installation.

The plugin uses a provider-adapter architecture, reuses OpenCode OAuth for the
OpenAI subscription check, reuses Claude Code OAuth for the Anthropic
subscription check, and accepts optional Admin API keys through environment
variables. It stores no historical snapshots and does not create a second usage
database in v1.

## Research Findings

The design was validated against current documentation and implementations on
2026-07-26.

- OpenCode assistant messages include `providerID`, `modelID`, recorded `cost`,
  and input, output, reasoning, cache-read, and cache-write token counts.
- OpenCode TUI plugins can register local slash commands through
  `api.keymap.registerLayer(...)`. A command can open a dialog without submitting
  a prompt or invoking a model.
- OpenAI exposes official organization usage and cost APIs that require an
  Admin API key. ChatGPT/Codex subscription allowance is a separate accounting
  surface exposed through Codex rate-limit data.
- Anthropic exposes official organization usage and cost APIs that require an
  Admin API key. Personal Claude subscription allowance is a separate consumer
  surface and does not have the same stability guarantees.
- Exact Gemini usage-versus-limit reporting generally requires Google Cloud
  Service Usage and Monitoring credentials. Gemini is therefore deferred until
  the provider contract is proven with OpenAI and Anthropic.
- Existing projects such as `@slkiser/opencode-quota` and
  `Opencode-token-counter` confirm both demand and technical feasibility.

Primary references:

- <https://opencode.ai/docs/plugins/>
- <https://opencode.ai/docs/commands/>
- <https://developers.openai.com/api/docs/guides/rate-limits>
- <https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/>
- <https://platform.claude.com/docs/en/manage-claude/usage-cost-api>
- <https://github.com/slkiser/opencode-quota>
- <https://github.com/coldhell7/Opencode-token-counter>

## Goals

- Provide one fast `/quota` command inside the OpenCode TUI.
- Avoid an LLM call when displaying the report.
- Support OpenAI and Anthropic in the first usable release.
- Clearly separate subscription allowance, API organization accounting, and
  local OpenCode accounting.
- Prefer authoritative provider data and identify the authority and freshness
  of every displayed metric.
- Degrade per provider so one failure does not hide healthy data.
- Keep credentials in memory and avoid persisting secrets.
- Make later provider additions independent of the command UI.

## Non-Goals

- Gemini, Copilot, OpenRouter, or custom provider support in v1.
- A browser dashboard, CSV or JSON export, status line, sidebar, toast, or alert.
- Automatic enforcement or model switching when a limit is low.
- Historical quota snapshots, burn-rate analysis, or a plugin-owned database.
- Organization billing reconciliation beyond provider-reported Admin API data.
- Web or desktop commands and an AI-callable tool.
- Command arguments, filtering, or multiple slash commands.

## Architecture

The npm package exports a TUI plugin entry at `opencode-quota-tracker/tui`.
Users load that entry through OpenCode's TUI plugin configuration. A server
plugin entry is intentionally excluded from v1 because the required command,
data access, and dialog rendering can all run locally in the TUI process.

The design has four layers:

### TUI Command Layer

The TUI entry registers `/quota` with `api.keymap.registerLayer(...)`. Its only
responsibilities are command registration, loading state, report rendering,
and plugin lifecycle cleanup.

### Report Service

`QuotaReportService` starts all applicable collectors concurrently, applies
timeouts and caching, waits for settled outcomes, and produces a normalized
report. It does not contain provider-specific parsing.

### Collectors

- `OpenCodeUsageCollector` reads local assistant-message accounting.
- `OpenAISubscriptionCollector` reads ChatGPT/Codex allowance windows.
- `OpenAIApiCollector` reads official OpenAI organization usage and cost.
- `AnthropicSubscriptionCollector` reads Claude consumer allowance windows.
- `AnthropicApiCollector` reads official Anthropic organization usage and cost.

Each collector owns credential discovery, request construction, response
validation, and translation to the normalized metric model.

### Infrastructure

Infrastructure modules provide read-only OpenCode SQLite access, HTTP requests,
timeouts, in-memory caching, credential redaction, clock access, and reset-time
formatting. These modules do not know about TUI components.

## Normalized Data Model

Collectors return a shared envelope equivalent to:

```ts
type QuotaMetric = {
  provider: "openai" | "anthropic" | "opencode"
  accountKind: "subscription" | "api_organization" | "local"
  kind: "allowance_window" | "token_usage" | "cost"
  label: string
  used?: number
  remaining?: number
  limit?: number
  unit: "percent" | "tokens" | "usd"
  resetsAt?: string
  authority: "authoritative" | "provider_reported" | "local_record"
  acquisition: "official_api" | "consumer_api" | "local_database"
  fetchedAt: string
  warning?: string
}
```

Percent values use explicit used and remaining fields. Adapters must never
assume that a provider field named `percent` means remaining. If a provider
returns only used percent, remaining is calculated as `100 - used` after
clamping used to the inclusive range from zero to 100.

Subscription windows and organization metrics remain separate records. The
report service never adds percentages to token counts, local recorded cost to
provider billing cost, or consumer allowance to API budgets.

## Provider Behavior

### OpenAI Subscription

The collector uses compatible OpenCode OAuth credentials and requests current
Codex rate-limit data from the OpenAI consumer service. Returned windows are
classified from provider-supplied duration metadata rather than hard-coded as
five-hour or weekly windows. The provider may return one or several windows.

This data is labeled `provider_reported` and `consumer_api` because the consumer
endpoint is not a stable public Admin API. A response-shape change affects only
this collector and produces `unsupported_response` in the report.

### OpenAI API Organization

When `OPENAI_ADMIN_API_KEY` is present, the collector requests month-to-date UTC
data from the official organization completions-usage and costs endpoints. It
follows pagination and reports token totals and provider-reported cost as
separate authoritative metrics.

An ordinary inference API key is not accepted as an Admin key. Missing or
insufficient permissions are reported without affecting subscription or local
accounting.

### Anthropic Subscription

The collector reuses Claude Code OAuth credentials, preferring the macOS
Keychain entry and otherwise reading `~/.claude/.credentials.json`, to request
consumer allowance windows. It does not source Anthropic personal OAuth from
OpenCode. Returned reset periods are accepted from the response rather than
inferred from fixed calendar rules.

This data is labeled `provider_reported` and `consumer_api`. The endpoint is
treated as volatile and its response is runtime-validated.

### Anthropic API Organization

When `ANTHROPIC_ADMIN_API_KEY` is present, the collector requests month-to-date
UTC message usage and cost from the official Usage and Cost Admin API. It
handles pagination and keeps token usage and monetary cost separate.

Admin API data is unavailable to unsupported individual accounts. That case is
reported as unavailable rather than as zero usage.

### Local OpenCode Accounting

The collector locates OpenCode's `opencode.db` using platform-aware data-path
candidates and opens it read-only. It aggregates completed assistant messages
for the current UTC day and UTC calendar month by provider and model.

The collector uses token and cost values already recorded on OpenCode assistant
messages. It does not recalculate prices or maintain a pricing catalog. These
values are labeled `local_record` and must not be presented as an invoice.

## `/quota` Experience

Running `/quota` opens a local scrollable dialog and writes nothing to the
conversation transcript.

The dialog has these sections:

1. `Subscription allowance`: OpenAI and Anthropic windows with used percent,
   remaining percent, and reset countdown.
2. `API organization`: month-to-date UTC tokens and authoritative cost for each
   configured Admin API.
3. `This OpenCode installation`: current UTC day and month-to-date local tokens
   and recorded cost grouped by provider.

Every provider block includes a source label and update time. Stale values have
a visible warning. Missing Admin keys show a short setup hint. A collector error
is rendered in its provider block while successful blocks remain available.

The command has no arguments in v1. Invoking `/quota` again performs a refresh
when the relevant cache entry has expired.

## Data Flow

1. The user invokes `/quota`.
2. The TUI replaces the dialog contents with a loading state.
3. `QuotaReportService` discovers which credentials and local data sources are
   available without exposing their values.
4. Applicable collectors run concurrently.
5. Each network collector has a five-second timeout and a five-minute in-memory
   success cache.
6. The service waits with `Promise.allSettled`, normalizes collector outcomes,
   and orders the report by account kind and provider.
7. The TUI replaces the loading dialog with the final report.
8. If a transient network request fails after a prior success in the same
   process, the prior value may be shown as stale with its original fetch time.

The cache is process-local. Restarting OpenCode clears it. No quota snapshot is
written to disk.

## Failure Model

Collector results use these explicit states:

- `ok`
- `not_configured`
- `unavailable`
- `unauthorized`
- `rate_limited`
- `timeout`
- `unsupported_response`
- `stale`

Provider HTTP bodies are runtime-validated before normalization. Empty,
ambiguous, or changed payloads never become zero-valued metrics. Network and
schema errors include a safe user-facing message and a redacted structured log.

The report itself fails only when the report service cannot initialize. Local
database absence or failure of every provider still produces a dialog that
explains which data sources are unavailable.

## Security And Privacy

- Admin keys are read only from `OPENAI_ADMIN_API_KEY` and
  `ANTHROPIC_ADMIN_API_KEY`.
- OpenAI subscription OAuth is reused from OpenCode. Anthropic subscription
  OAuth is reused from Claude Code's macOS Keychain entry or
  `~/.claude/.credentials.json`.
- Admin keys and OAuth tokens are never persisted, logged, included in errors,
  or rendered.
- OAuth tokens are sent only to an allowlisted HTTPS host owned by the original
  provider.
- Provider account identifiers are masked for display and removed from logs.
- OpenCode's database is opened in read-only mode and is never migrated or
  modified.
- Network responses are retained only in the in-memory cache.
- Logs use OpenCode's structured logger and pass through a redaction boundary.
- Diagnostics distinguish missing credentials from invalid credentials without
  revealing key prefixes or values.

## Testing Strategy

### Unit Tests

- Normalize each metric kind and reject invalid combinations.
- Verify used-versus-remaining percentage semantics and clamping.
- Format reset timestamps and expired windows deterministically with a fake
  clock.
- Verify timeout, cache, stale fallback, and concurrent settlement behavior.
- Verify secret and account-identifier redaction.
- Validate provider payload fixtures, including missing and unknown fields.

### Collector Tests

- Test OpenAI subscription responses with one and multiple duration-based
  windows.
- Test OpenAI Admin usage and cost pagination.
- Test Anthropic subscription response variants.
- Test Anthropic Admin usage and cost pagination.
- Test missing, invalid, unauthorized, rate-limited, and malformed responses.
- Test local SQLite aggregation with a fixture database and verify read-only
  access.

All normal collector tests use mocked HTTP and fixture credentials. They never
call live provider endpoints.

### TUI Tests

- Verify `/quota` registration through the keymap layer.
- Verify command execution never submits a prompt or invokes a model.
- Verify loading, complete, partial-failure, and all-unavailable dialogs.
- Verify long reports remain scrollable and cleanup runs when the plugin unloads.

### Optional Smoke Tests

Credential-gated smoke tests may call official Admin APIs manually. They are
excluded from standard CI and must not print provider responses or credentials.

## Acceptance Criteria

- Installing the TUI entry makes `/quota` discoverable in OpenCode.
- `/quota` opens a deterministic local dialog without an LLM request.
- OpenAI and Anthropic subscription windows appear when compatible OAuth is
  available.
- Official organization usage and cost appear when the corresponding Admin key
  is present.
- Local OpenCode day and month accounting appears when `opencode.db` exists.
- Every metric identifies account kind, authority, source, and freshness.
- Missing credentials and per-provider failures remain isolated and actionable.
- No secret is written to disk, logs, errors, snapshots, or UI output.
- The plugin creates no historical database and writes nothing to
  `opencode.db`.

## Future Extensions

After v1 proves the adapter contract, later designs may add Gemini, Copilot,
OpenRouter, custom provider adapters, JSON output, a standalone CLI, historical
snapshots, alerts, status-line or sidebar surfaces, and web or desktop support.
Each extension requires its own design because it changes credentials,
persistence, or presentation scope.
