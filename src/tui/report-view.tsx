import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { Accessor } from "solid-js"

import type {
  AccountKind,
  CollectorOutcome,
  QuotaMetric,
  QuotaReport,
} from "../domain/quota.js"
import { formatResetCountdown, formatTokens, formatUsd } from "../domain/format.js"

export type ReportViewState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly report: QuotaReport; readonly now: Date }
  | { readonly status: "error"; readonly message: string }

export interface ReportViewProps {
  readonly state: ReportViewState
  readonly theme: TuiThemeCurrent
}

export interface ReportLine {
  readonly text: string
  readonly tone: "accent" | "text" | "muted" | "warm" | "danger" | "stale"
  readonly emphasis?: boolean
}

const sectionDefinitions: readonly { readonly kind: AccountKind; readonly title: string; readonly eyebrow: string }[] = [
  { kind: "subscription", title: "Subscription allowance", eyebrow: "CONSUMER BUDGETS" },
  { kind: "api_organization", title: "API organization", eyebrow: "BILLABLE SURFACES" },
  { kind: "local", title: "This OpenCode installation", eyebrow: "LOCAL RECORD" },
]

export function reportToneColor(
  theme: TuiThemeCurrent,
  tone: ReportLine["tone"],
): TuiThemeCurrent["accent"] {
  const colors: Readonly<Record<ReportLine["tone"], TuiThemeCurrent["accent"]>> = {
    accent: theme.accent,
    text: theme.text,
    muted: theme.textMuted,
    warm: theme.warning,
    danger: theme.error,
    stale: theme.warning,
  }
  return colors[tone]
}

function providerLabel(provider: string, accountKind: AccountKind): string {
  return `${provider.toUpperCase()} / ${accountKind.replace("_", " ").toUpperCase()}`
}

function ageLabel(fetchedAt: Date, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - fetchedAt.getTime())
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function sourceLabel(metric: QuotaMetric): string {
  return `${metric.authority} · ${metric.acquisition}`
}

function metricValue(metric: QuotaMetric, now: Date): string {
  if (metric.kind === "allowance_window") {
    const reset = metric.resetsAt ? ` · resets in ${formatResetCountdown(metric.resetsAt, now)}` : ""
    return `${metric.used}% used · ${metric.remaining}% left${reset}`
  }
  if (metric.kind === "token_usage") return `${formatTokens(metric.used)} tokens`
  return formatUsd(metric.used)
}

function setupHint(outcome: CollectorOutcome): string | undefined {
  if (outcome.state !== "not_configured") return undefined
  if (outcome.accountKind === "api_organization") {
    return `Set ${outcome.provider === "openai" ? "OPENAI_ADMIN_API_KEY" : "ANTHROPIC_ADMIN_API_KEY"} to enable Admin accounting.`
  }
  if (outcome.provider === "anthropic") return "Set up Claude Code authentication to enable subscription allowance."
  if (outcome.provider === "openai") return "Sign in to OpenCode to enable subscription allowance."
  return undefined
}

function push(lines: ReportLine[], text: string, tone: ReportLine["tone"], emphasis = false): void {
  lines.push({ text, tone, ...(emphasis ? { emphasis: true } : {}) })
}

function renderOutcome(lines: ReportLine[], outcome: CollectorOutcome, now: Date): void {
  const isMetricOutcome = outcome.state === "ok" || outcome.state === "stale"
  const firstMetric = isMetricOutcome ? outcome.metrics[0] : undefined
  const statusTone = outcome.state === "ok" ? "accent" : outcome.state === "stale" ? "stale" : "danger"
  push(lines, `  ${providerLabel(outcome.provider, outcome.accountKind)}  ${outcome.state.toUpperCase()}`, statusTone, true)

  if (firstMetric) push(lines, `    ${sourceLabel(firstMetric)}`, "muted")
  if (isMetricOutcome) {
    for (const metric of outcome.metrics) {
      push(lines, `    ${metric.label}: ${metricValue(metric, now)}`, metric.kind === "cost" ? "warm" : "text")
    }
    push(lines, `    updated ${ageLabel(outcome.fetchedAt, now)}`, "muted")
    if (outcome.state === "stale" && outcome.warning) push(lines, `    ${outcome.warning}`, "stale")
    return
  }

  push(lines, `    ${outcome.message}`, "danger")
  const hint = setupHint(outcome)
  if (hint) push(lines, `    ${hint}`, "warm")
}

export function getReportLines(state: ReportViewState): readonly ReportLine[] {
  const lines: ReportLine[] = []
  push(lines, "QUOTA / LIVE READ", "accent", true)
  push(lines, "UTC · /quota", "muted")

  if (state.status === "loading") {
    push(lines, "Collecting provider data", "warm", true)
    push(lines, "Reading subscription, Admin, and local usage sources...", "muted")
    return lines
  }
  if (state.status === "error") {
    push(lines, "Unable to generate quota report", "danger", true)
    push(lines, state.message, "muted")
    return lines
  }

  let hasUsableOutcome = false
  for (const definition of sectionDefinitions) {
    push(lines, definition.eyebrow, "accent", true)
    push(lines, definition.title, "text", true)
    const sections = state.report.sections.filter((section) => section.accountKind === definition.kind)
    if (sections.length === 0) {
      push(lines, "  No source reported data for this section.", "muted")
      continue
    }
    for (const section of sections) {
      for (const outcome of section.outcomes) {
        if (outcome.state === "ok" || outcome.state === "stale") hasUsableOutcome = true
        renderOutcome(lines, outcome, state.now)
      }
    }
  }

  if (!hasUsableOutcome) {
    push(lines, "No quota sources are currently available.", "danger", true)
    push(lines, "Check credentials and try /quota again.", "muted")
  }
  return lines
}

export function createReportLines(state: Accessor<ReportViewState>): Accessor<readonly ReportLine[]> {
  return () => getReportLines(state())
}

export function ReportView(props: ReportViewProps) {
  const lines = createReportLines(() => props.state)
  const header = () => lines().slice(0, 2)
  const body = () => lines().slice(2)

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={props.theme.background} padding={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%" marginBottom={1}>
        <text fg={reportToneColor(props.theme, header()[0]?.tone ?? "accent")} attributes={1}>
          {header()[0]?.text ?? "QUOTA / LIVE READ"}
        </text>
        <text fg={reportToneColor(props.theme, header()[1]?.tone ?? "muted")}>
          {header()[1]?.text ?? "UTC · /quota"}
        </text>
      </box>
      <scrollbox width="100%" height="100%" flexDirection="column" stickyScroll stickyStart="top">
        {body().map((line) => (
          <text fg={reportToneColor(props.theme, line.tone)} attributes={line.emphasis ? 1 : 0}>
            {line.text}
          </text>
        ))}
      </scrollbox>
    </box>
  )
}
