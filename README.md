# OpenCode Quota Tracker

<p align="center">
  <img src="./public/opencode-quota-tracker-logo.svg" alt="OpenCode Quota Tracker logo" width="240">
</p>

`opencode-quota-tracker` adds a local `/quota` command to the OpenCode TUI. It reads provider quota data and the usage already recorded by OpenCode, then shows the result in a scrollable full-screen view. The command does not submit a prompt or call a model.

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

Restart OpenCode after changing the plugin configuration. Type `/quota` in the TUI and run the command. It opens a local full-screen view and leaves the conversation transcript unchanged.

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
opencode plugin opencode-quota-tracker@latest --global --force
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

## Continuous integration

Pull requests run `pnpm check` in GitHub Actions, using the Node.js and pnpm versions declared by this package. Ordinary pull requests do not publish the package. To prevent unverified changes from reaching `main`, make the `Check` status required in the branch protection rules for the default branch.

## Publishing releases

Releases are prepared and approved manually, then published by an explicitly dispatched GitHub Actions workflow. Publishing uses npm Trusted Publishing: GitHub Actions exchanges a short-lived OpenID Connect credential with npm, so the repository does not need an `NPM_TOKEN` secret.

Configure publishing once before creating the next release:

1. Create a GitHub environment named `npm`. No environment secret is required.
2. Restrict the environment to the `main` deployment branch and disable administrator bypass. This prevents a modified workflow on another branch from requesting npm publishing credentials.
3. In the npm package settings for `opencode-quota-tracker`, add a GitHub Actions trusted publisher with owner `yehezkielgunawan`, repository `opencode-quota-tracker`, workflow filename `publish.yml`, environment `npm`, and publish permission.

Prepare each release in a pull request. Choose the appropriate SemVer increment instead of `patch` when needed, add the release notes to `CHANGELOG.md`, and verify the package:

```bash
pnpm version patch --no-git-tag-version
pnpm check
npm pack --dry-run
VERSION=$(node -p "require('./package.json').version")
git add package.json CHANGELOG.md
git commit -m "chore: release $VERSION"
git push
```

After the version pull request passes CI and merges, create a non-draft GitHub Release from `main` with a tag exactly matching `v` plus the committed package version:

```bash
git switch main
git pull --ff-only
VERSION=$(node -p "require('./package.json').version")
gh release create "v$VERSION" --target main --generate-notes
```

Creating the pull request, merging it, and publishing the GitHub Release do not publish to npm. Open the `Publish` workflow in GitHub Actions, choose **Run workflow**, select `main`, and enter the exact release tag. The same action can be started with the GitHub CLI:

```bash
gh workflow run publish.yml --ref main -f tag="v$VERSION"
```

The workflow requires an existing, non-draft GitHub Release, checks out the exact tag, verifies it against `package.json`, repeats all package checks, rebuilds through `prepack`, publishes publicly, and records npm provenance. Do not run `npm publish` locally for a workflow-managed release.

If npm rejects the workflow identity, confirm every Trusted Publisher field matches exactly. A failed publish can be retried or dispatched again only while that version is absent from npm. npm rejects versions that have already been published and does not permit overwriting them.

## Scope

The first release supports OpenAI and Anthropic subscription and organization accounting plus local OpenCode usage. Gemini, Copilot, OpenRouter, historical snapshots, alerts, exports, and a standalone web dashboard are outside this package's current scope.

## License

MIT. See [LICENSE](./LICENSE).
