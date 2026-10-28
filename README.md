# OpenCode Quota Tracker

<p align="center">
  <img src="./public/opencode-quota-tracker-logo.svg" alt="OpenCode Quota Tracker logo" width="240">
</p>

> So far only GPT and Claude are supported. Gemini, Copilot, OpenRouter, and other providers are not yet supported.

`opencode-quota-tracker` adds a local `/quota` command to the OpenCode TUI. It reads provider quota data and the usage already recorded by OpenCode, then shows the result in a scrollable full-screen view. The command does not submit a prompt or call a model.

## Requirements

- OpenCode `2.2.0` or newer within V2 (V1 is not supported by this release)
- Node.js `22.12.0` or newer when building or testing this package
- A terminal OpenCode session for the TUI entry

## Install in OpenCode

Add the package to the `plugins` array in your global `~/.config/opencode/cli.json` (or `$XDG_CONFIG_HOME/opencode/cli.json`):

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["opencode-quota-tracker"]
}
```

If you already have plugins, add this value without removing the existing entries. OpenCode resolves the npm package and loads its `./tui` export. This package is TUI-only: do not add it to the server's `opencode.json`. V2 has no project-local `cli.json`.

Start OpenCode, type `/quota` in the TUI, and run the command. It opens a local full-screen view and leaves the conversation transcript unchanged. Press Escape to return to the previous page.

For local development, build this repository with `pnpm build` and add its absolute **directory** path to `cli.json`'s `plugins` array. V2 resolves the directory's `package.json` and `./tui` export; do not point it directly at `dist/tui.js`.

### Migrating from V1

Move this package's entry out of the old `tui.json` `plugin` array and into `cli.json`'s `plugins` array. The new release uses the V2 plugin API and does not run on V1; retain package version `0.1.4` if you still use V1. Do not load both releases together.

All collection runs on the terminal client's machine, including when connected to a remote server. The plugin does not read remote-server credentials or usage through the connected API.

## Configure credentials

The command has three separate data sections. A missing credential hides only its own provider block.

### Subscription allowance

OpenAI subscription data uses the selected OpenAI OAuth credential in the local OpenCode V2 database. An ordinary `OPENAI_API_KEY` or selected inference API key is not used for this section. The plugin reads credentials but never refreshes or writes them; reauthenticate in OpenCode if the stored token has expired.

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
3. `This OpenCode installation` shows current UTC day and month-to-date tokens and recorded cost from completed V2 assistant messages in the local database, grouped by provider and model. Token totals include input, output, reasoning, cache reads, and cache writes. Separate compaction records and unmigrated V1 message records are not included.

Configured provider blocks show their state, data authority, acquisition source, and freshness. Unconfigured blocks and sections with no visible providers are omitted; if every source is unconfigured, the view shows a short sign-in or Admin key prompt. A network or permission failure stays in its provider block instead of hiding successful data from other providers. A stale block is marked `STALE` when the last successful in-memory value is shown after a refresh failure. Historical per-model usage from this OpenCode installation remains visible.

The cache lasts five minutes and exists only in the running OpenCode process. Running `/quota` again after the cache expires refreshes the report. Reset countdowns and local day/month boundaries use UTC. Local cost is the value recorded by OpenCode, not an invoice calculation.

## Privacy and data access

- OAuth tokens and Admin keys stay in memory and are never rendered, logged, or persisted by this plugin.
- Provider requests use allowlisted HTTPS hosts and bounded timeouts.
- Network responses are retained only in the process-local cache.
- OpenCode's database is opened read-only for selected credentials and usage. Paths follow V2's XDG roots on all platforms, with `OPENCODE_DB` and channel-specific database selection respected. In-memory server databases cannot be read by this plugin.
- The plugin does not create a database, write OpenCode records, or store quota history.
- Account identifiers are redacted before they can reach diagnostics.

## Troubleshooting

**`/quota` is not discoverable:** Confirm you are running OpenCode `2.2.0` or newer within V2 and that `opencode-quota-tracker` is in global `cli.json`'s `plugins` array. OpenCode selects the package's `./tui` export automatically. Remove any duplicate V1 entry. To select a particular published release, use `opencode-quota-tracker@<version>` in that array.

**An Admin block is missing:** Export the matching Admin variable in the environment that launches OpenCode. `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` do not enable Admin accounting.

**A subscription block is missing:** Sign in to OpenCode for OpenAI, or install and sign in with Claude Code for Anthropic. On macOS, check the Claude Code Keychain entry; on other systems, check the credentials file path.

**Local usage is unavailable:** The plugin could not find or read the local V2 database or its usage schema. Check the terminal client's `XDG_DATA_HOME`, `OPENCODE_DB`, and release channel. Remote or in-memory databases are not available through local file reads. The plugin does not create a replacement database. Provider sections can still load normally.

**A consumer response is unsupported:** Subscription endpoints are provider consumer surfaces and can change without notice. The plugin reports the changed payload instead of treating it as zero usage.

## Build and verify from source

```bash
pnpm install
pnpm check
npm pack --dry-run
```

`pnpm check` runs strict typechecking, the full Vitest suite, and the production build. The package publishes `dist/`, `README.md`, and `LICENSE`; tests, fixtures, credentials, coverage output, and local databases are excluded.

## Continuous integration

Pull requests run `pnpm check` in GitHub Actions, using the Node.js and pnpm versions declared by this package. Ordinary pull requests do not publish the package. Make the `Check` status required in the branch protection rules for `main` so unverified changes cannot be merged.

## Publishing releases

Merging a release-worthy pull request into `main` triggers `.github/workflows/publish.yml`. It runs `pnpm check` before semantic-release determines the next version from Conventional Commit messages. The workflow updates `package.json` and `CHANGELOG.md` in a release commit, creates the `v<version>` tag and GitHub Release, and publishes to npm. npm Trusted Publishing uses short-lived OpenID Connect credentials and records provenance; no `NPM_TOKEN` is needed. A merge without release-worthy commits runs the checks but does not publish.

Configure publishing once:

1. Keep a GitHub environment named `npm`, restricted to deployments from `main`, with administrator bypass disabled. Leave required reviewers unset for automatic publishing.
2. Create a GitHub App installed only on this repository. Grant **Contents: read/write**, **Issues: read/write**, and **Pull requests: read/write** for the release commit, GitHub Release, and release notifications. Allow this App to bypass `main`'s required-PR and status-check rules so it can push the release commit; keep those rules for everyone else. If your rules require signed commits, the App also needs an appropriate exception because the git plugin creates the commit locally.
3. Add the App ID as the repository variable `RELEASE_APP_ID` and its private key as the repository secret `RELEASE_APP_PRIVATE_KEY`.
4. In the npm settings for `opencode-quota-tracker`, confirm the GitHub Actions Trusted Publisher uses owner `yehezkielgunawan`, repository `opencode-quota-tracker`, workflow filename **`publish.yml`**, environment **`npm`**, and permission for direct `npm publish`. The filename must match exactly. The release job needs `id-token: write` and a GitHub-hosted runner.
5. Enable squash merges with the PR title as the squash commit subject. Keep the `Check` PR status required. Review the resulting squash message before merging: semantic-release analyzes the commit message, not the PR labels or branch name.

Use Conventional Commit titles for changes intended to publish: `fix: ...` produces a patch, `feat: ...` a minor, and a `BREAKING CHANGE: ...` footer in the squash commit body a major release. Other titles such as `docs: ...`, `test: ...`, and `chore: ...` do not publish by default. Keep the breaking-change footer when GitHub prompts you to confirm the squash message. Do not edit versions or release notes manually; semantic-release writes them for each release.

The migration starts from the existing `v0.1.4` tag and npm `0.1.4` package. Keep that tag in Git history: the next `fix:` release will be `0.1.5`, and a `feat:` release will be `0.2.0`. The release workflow uses Node 24 (24.15 or later) and npm 11.5.1 or later for the release tooling and npm OIDC.

If a release fails, inspect the Git tag, GitHub Release, and npm version before retrying. A tag can have been pushed before npm publishing fails; npm does not allow a published version to be overwritten. For OIDC authentication errors, check the Trusted Publisher's repository, workflow filename, environment, and direct-publish permission; for a protected-branch push failure, check the GitHub App installation and bypass rule.

## Scope

The first release supports OpenAI and Anthropic subscription and organization accounting plus local OpenCode usage. Gemini, Copilot, OpenRouter, historical snapshots, alerts, exports, and a standalone web dashboard are outside this package's current scope.

## License

MIT. See [LICENSE](./LICENSE).
