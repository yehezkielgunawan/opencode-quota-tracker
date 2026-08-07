import { describe, expect, it } from "vitest"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"

import { createAllowanceMetric, createCostMetric, createTokenUsageMetric, type QuotaReport } from "../../src/domain/quota.js"
import {
  createReportLines,
  getReportLines,
  reportToneColor,
  type ReportLine,
  type ReportViewState,
} from "../../src/tui/report-view.js"

const NOW = new Date("2026-07-31T12:00:00.000Z")
function report(overrides: Partial<QuotaReport> = {}): QuotaReport {
  const fetchedAt = new Date("2026-07-31T11:59:00.000Z")
  return {
    generatedAt: NOW,
    sections: [
      {
        provider: "openai",
        accountKind: "subscription",
        outcomes: [
          {
            collectorId: "openai-subscription",
            provider: "openai",
            accountKind: "subscription",
            state: "ok",
            fetchedAt,
            metrics: [
              createAllowanceMetric({
                provider: "openai",
                accountKind: "subscription",
                label: "Primary · 5h window",
                used: 42,
                authority: "provider_reported",
                acquisition: "consumer_api",
                fetchedAt,
                resetsAt: new Date("2026-07-31T12:05:00.000Z"),
              }),
            ],
          },
        ],
      },
      {
        provider: "anthropic",
        accountKind: "subscription",
        outcomes: [
          {
            collectorId: "anthropic-subscription",
            provider: "anthropic",
            accountKind: "subscription",
            state: "not_configured",
            fetchedAt,
            message: "Claude authentication is not configured.",
          },
        ],
      },
      {
        provider: "openai",
        accountKind: "api_organization",
        outcomes: [
          {
            collectorId: "openai-admin",
            provider: "openai",
            accountKind: "api_organization",
            state: "ok",
            fetchedAt,
            metrics: [
              createTokenUsageMetric({
                provider: "openai",
                accountKind: "api_organization",
                label: "Month · OpenAI API completions",
                used: 12_345,
                authority: "authoritative",
                acquisition: "official_api",
                fetchedAt,
              }),
              createCostMetric({
                provider: "openai",
                accountKind: "api_organization",
                label: "Month · OpenAI API cost",
                used: 1.25,
                authority: "authoritative",
                acquisition: "official_api",
                fetchedAt,
              }),
            ],
          },
        ],
      },
      {
        provider: "anthropic",
        accountKind: "api_organization",
        outcomes: [
          {
            collectorId: "anthropic-admin",
            provider: "anthropic",
            accountKind: "api_organization",
            state: "not_configured",
            fetchedAt,
            message: "Anthropic Admin API key is not configured.",
          },
        ],
      },
      {
        provider: "opencode",
        accountKind: "local",
        outcomes: [
          {
            collectorId: "opencode-usage",
            provider: "opencode",
            accountKind: "local",
            state: "stale",
            fetchedAt: new Date("2026-07-31T11:30:00.000Z"),
            warning: "Refresh failed; showing the last successful result.",
            message: "Cached quota data is stale.",
            metrics: [
              createTokenUsageMetric({
                provider: "opencode",
                accountKind: "local",
                label: "Today · openai/gpt-4.1",
                used: 987,
                authority: "local_record",
                acquisition: "local_database",
                fetchedAt,
              }),
            ],
          },
        ],
      },
    ],
    ...overrides,
  }
}

function readyState(value = report()): ReportViewState {
  return { status: "ready", report: value, now: NOW }
}

function output(state: ReportViewState): string {
  return getReportLines(state)
    .map((line) => line.text)
    .join("\n")
}

describe("ReportView", () => {
  it("recomputes rendered lines when the route state changes", () => {
    let state: ReportViewState = { status: "loading" }
    const lines = createReportLines(() => state)

    expect(lines().map((line) => line.text)).toContain("Collecting provider data")

    state = { status: "error", message: "Quota sources could not be read." }

    expect(lines().map((line) => line.text)).toContain("Unable to generate quota report")
    expect(lines().map((line) => line.text)).not.toContain("Collecting provider data")
  })

  it("resolves every report tone from the active theme", () => {
    const theme = {
      accent: { token: "accent" },
      text: { token: "text" },
      textMuted: { token: "muted" },
      warning: { token: "warning" },
      error: { token: "error" },
    } as unknown as TuiThemeCurrent
    const expected: Record<ReportLine["tone"], unknown> = {
      accent: theme.accent,
      text: theme.text,
      muted: theme.textMuted,
      warm: theme.warning,
      danger: theme.error,
      stale: theme.warning,
    }

    for (const [tone, color] of Object.entries(expected)) {
      expect(reportToneColor(theme, tone as ReportLine["tone"])).toBe(color)
    }
  })

  it("shows a loading state without pretending that data is available", async () => {
    const output = outputFor({ status: "loading" })

    expect(output).toContain("QUOTA / LIVE READ")
    expect(output).toContain("Collecting provider data")
    expect(output).not.toContain("Subscription allowance")
  })

  it("renders the three account sections, source labels, reset countdowns, and metrics", async () => {
    const output = outputFor(readyState())

    expect(output).toContain("Subscription allowance")
    expect(output).toContain("API organization")
    expect(output).toContain("This OpenCode installation")
    expect(output).toContain("OPENAI / SUBSCRIPTION")
    expect(output).toContain("provider_reported · consumer_api")
    expect(output).toContain("resets in 5m")
    expect(output).toContain("12,345 tokens")
    expect(output).toContain("$1.25")
    expect(output).toContain("local_record · local_database")
  })

  it("keeps successful providers visible beside failures and shows Admin setup hints", async () => {
    const output = outputFor(readyState())

    expect(output).toContain("OPENAI / SUBSCRIPTION")
    expect(output).toContain("ANTHROPIC / API ORGANIZATION")
    expect(output).toContain("NOT_CONFIGURED")
    expect(output).toContain("Set ANTHROPIC_ADMIN_API_KEY")
    expect(output).toContain("Set up Claude Code authentication")
  })

  it("marks stale values explicitly and preserves their original freshness time", async () => {
    const output = outputFor(readyState())

    expect(output).toContain("STALE")
    expect(output).toContain("Refresh failed; showing the last successful result.")
    expect(output).toContain("updated 30m ago")
  })

  it("renders an all-unavailable report as an actionable empty state", async () => {
    const unavailable: QuotaReport = {
      generatedAt: NOW,
      sections: [
        {
          provider: "openai",
          accountKind: "subscription",
          outcomes: [
            {
              collectorId: "openai-subscription",
              provider: "openai",
              accountKind: "subscription",
              state: "unavailable",
              fetchedAt: NOW,
              message: "OpenAI quota is unavailable.",
            },
          ],
        },
      ],
    }

    const output = outputFor(readyState(unavailable))

    expect(output).toContain("No quota sources are currently available")
    expect(output).toContain("Check credentials and try /quota again")
  })
})

function outputFor(state: ReportViewState): string {
  return output(state)
}
