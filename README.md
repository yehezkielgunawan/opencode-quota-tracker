# OpenCode Quota Tracker

`opencode-quota-tracker` adds a local `/quota` command to the OpenCode TUI. It reads provider quota data and the usage already recorded by OpenCode, then shows the result in a scrollable dialog. The command does not submit a prompt or call a model.

## Requirements

- OpenCode `1.18` or newer
- Node.js `22.12.0` or newer when building or testing this package
- A terminal OpenCode session for the TUI entry

## Install in OpenCode

The OpenCode CLI can install the plugin and update your global config directly:

```bash
opencode plugin opencode-quota-tracker --global
```

Use the project config instead when the plugin should apply only to one repository:

Add the package to the `plugin` array in either your project `.opencode/tui.json` or your global `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-quota-tracker"]
}
```

If you already have plugins, add this value without removing the existing entries. OpenCode installs npm plugins with Bun when it starts. You can also install the package yourself with npm or pnpm:

```bash
npm install opencode-quota-tracker
# or
pnpm add opencode-quota-tracker
```

Restart OpenCode after changing the plugin configuration. Type `/quota` in the TUI and run the command. It opens a local dialog and leaves the conversation transcript unchanged.

OpenCode also loads local JavaScript and TypeScript plugins from these directories:

- Project: `.opencode/plugins/`
- Global: `~/.config/opencode/plugins/`

For local development, build this repository with `pnpm build` and use the generated `dist/tui.js` as the plugin entry. The published package is the simpler option because its relative runtime modules and peer dependencies are already packaged for the `./tui` export.

## Configure credentials

The command has three separate data sections. A missing credential affects only its own provider block.

### Subscription allowance

OpenAI subscription data uses the OAuth account already configured in OpenCode. An ordinary `OPENAI_API_KEY` is not used for this section.

Anthropic subscription data uses Claude Code OAuth. On macOS, the plugin first checks the Keychain service `Claude Code-credentials`. It then falls back to `~/.claude/.credentials.json`. Anthropic OAuth from OpenCode is not used.

### API organization

Set an Admin API key before starting OpenCode when you want organization usage and cost:

```bash
export OPENAI_ADMIN_API_KEY="your-openai-admin-key"
export ANTHROPIC_ADMIN_API_KEY="your-anthropic-admin-key"
opencode
```

These keys are read only from the two variables above. Provider inference keys are not treated as Admin keys. Admin data is month-to-date in UTC and appears as separate token and USD records.

Do not paste real keys into `opencode.json`, this README, issue reports, or shell history. Prefer your shell's secret manager or an environment mechanism that does not persist the value in project files.

## Read the report

`/quota` groups results by account kind:

1. `Subscription allowance` shows provider-reported used percent, remaining percent, and provider reset countdowns.
2. `API organization` shows official Admin API message tokens and provider-reported USD cost for the current UTC month.
3. `This OpenCode installation` shows current UTC day and month-to-date tokens and recorded cost from OpenCode's own database.

Each provider block shows its state, data authority, acquisition source, and freshness. A `NOT_CONFIGURED` block includes the relevant setup hint. A network or permission failure stays in that provider block instead of hiding successful data from other providers. A stale block is marked `STALE` when the last successful in-memory value is shown after a refresh failure.

The cache lasts five minutes and exists only in the running OpenCode process. Running `/quota` again after the cache expires refreshes the report. Reset countdowns and local day/month boundaries use UTC. Local cost is the value recorded by OpenCode, not an invoice calculation.

## Privacy and data access

- OAuth tokens and Admin keys stay in memory and are never rendered, logged, or persisted by this plugin.
- Provider requests use allowlisted HTTPS hosts and bounded timeouts.
- Network responses are retained only in the process-local cache.
- OpenCode's `opencode.db` is opened read-only.
- The plugin does not create a database, write OpenCode records, or store quota history.
- Account identifiers are redacted before they can reach diagnostics.

## Troubleshooting

**`/quota` is not discoverable:** Confirm the exact `opencode-quota-tracker` value is in the `plugin` array, then restart OpenCode. OpenCode selects the package's `./tui` export automatically. Check that the package name is not nested under another config key. If an older release is cached, refresh the current package explicitly:

```bash
opencode plugin opencode-quota-tracker@0.1.1 --global --force
```

**An Admin block says `NOT_CONFIGURED`:** Export the matching Admin variable in the environment that launches OpenCode. `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` do not enable Admin accounting.

**A subscription block says `NOT_CONFIGURED`:** Sign in to OpenCode for OpenAI, or install and sign in with Claude Code for Anthropic. On macOS, check the Claude Code Keychain entry; on other systems, check the credentials file path.

**Local usage is unavailable:** The plugin could not find or read OpenCode's database. It does not create a replacement database. Provider sections can still load normally.

**A consumer response is unsupported:** Subscription endpoints are provider consumer surfaces and can change without notice. The plugin reports the changed payload instead of treating it as zero usage.

## Build and verify from source

```bash
pnpm install
pnpm check
npm pack --dry-run
```

`pnpm check` runs strict typechecking, the full Vitest suite, and the production build. The package publishes `dist/`, `README.md`, and `LICENSE`; tests, fixtures, credentials, coverage output, and local databases are excluded.

## Scope

The first release supports OpenAI and Anthropic subscription and organization accounting plus local OpenCode usage. Gemini, Copilot, OpenRouter, historical snapshots, alerts, exports, and a standalone web dashboard are outside this package's current scope.

## License

MIT. See [LICENSE](./LICENSE).
