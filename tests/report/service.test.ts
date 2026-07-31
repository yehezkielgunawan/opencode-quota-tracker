import { afterEach, describe, expect, it, vi } from "vitest"

import type { Collector, CollectorOutcome } from "../../src/domain/quota.js"
import { QuotaReportService } from "../../src/report/service.js"

const now = new Date("2026-07-31T12:00:00.000Z")

function outcome(
  collectorId: string,
  provider: Collector["provider"],
  accountKind: Collector["accountKind"],
  state: "ok" | "not_configured" = "ok",
): CollectorOutcome {
  const base = { collectorId, provider, accountKind, fetchedAt: now }
  return state === "ok"
    ? { ...base, state, metrics: [] }
    : { ...base, state, message: "Not configured." }
}

function collector(
  id: string,
  provider: Collector["provider"],
  accountKind: Collector["accountKind"],
  collect: Collector["collect"],
): Collector {
  return { id, provider, accountKind, collect }
}

describe("QuotaReportService", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("starts every collector before awaiting any result", async () => {
    const starts: string[] = []
    let resolveFirst!: (value: CollectorOutcome) => void
    const first = collector("first", "openai", "subscription", () => {
      starts.push("first")
      return new Promise((resolve) => {
        resolveFirst = resolve
      })
    })
    const second = collector("second", "anthropic", "subscription", async () => {
      starts.push("second")
      return outcome("second", "anthropic", "subscription")
    })
    const service = new QuotaReportService({ collectors: [first, second], now: () => now })

    const report = service.generate()
    expect(starts).toEqual(["first", "second"])
    resolveFirst(outcome("first", "openai", "subscription"))

    await expect(report).resolves.toMatchObject({ generatedAt: now })
  })

  it("isolates resolved, rejected, hanging, and not-configured collectors", async () => {
    vi.useFakeTimers()
    const collectors: Collector[] = [
      collector("success", "openai", "subscription", async () =>
        outcome("success", "openai", "subscription"),
      ),
      collector("rejected", "anthropic", "api_organization", async () => {
        throw new Error("Bearer exception-secret")
      }),
      collector("hanging", "opencode", "local", () => new Promise(() => {})),
      collector("missing", "anthropic", "subscription", async () =>
        outcome("missing", "anthropic", "subscription", "not_configured"),
      ),
    ]
    const service = new QuotaReportService({ collectors, now: () => now })

    const pending = service.generate()
    await vi.advanceTimersByTimeAsync(5_000)
    const report = await pending
    const outcomes = report.sections.flatMap((section) => section.outcomes)

    expect(outcomes.map(({ collectorId, state }) => [collectorId, state])).toEqual([
      ["success", "ok"],
      ["missing", "not_configured"],
      ["rejected", "unavailable"],
      ["hanging", "timeout"],
    ])
    expect(JSON.stringify(report)).not.toContain("exception-secret")
    expect(outcomes.find(({ collectorId }) => collectorId === "rejected")).toMatchObject({
      message: "Collector is unavailable.",
    })
    expect(outcomes.find(({ collectorId }) => collectorId === "hanging")).toMatchObject({
      message: "Collector timed out.",
    })
  })

  it("orders sections by account kind, provider, and outcomes by collector id", async () => {
    const definitions = [
      ["z-local", "opencode", "local"],
      ["z-openai", "openai", "subscription"],
      ["anthropic-api", "anthropic", "api_organization"],
      ["opencode-subscription", "opencode", "subscription"],
      ["a-openai", "openai", "subscription"],
      ["openai-api", "openai", "api_organization"],
    ] as const
    const collectors = definitions.map(([id, provider, accountKind]) =>
      collector(id, provider, accountKind, async () => outcome(id, provider, accountKind)),
    )
    const service = new QuotaReportService({ collectors, now: () => now })

    const report = await service.generate()

    expect(
      report.sections.map(({ accountKind, provider, outcomes }) => [
        accountKind,
        provider,
        outcomes.map(({ collectorId }) => collectorId),
      ]),
    ).toEqual([
      ["subscription", "openai", ["a-openai", "z-openai"]],
      ["subscription", "opencode", ["opencode-subscription"]],
      ["api_organization", "openai", ["openai-api"]],
      ["api_organization", "anthropic", ["anthropic-api"]],
      ["local", "opencode", ["z-local"]],
    ])
  })

  it("keeps result identities stable when the caller mutates its collector array", async () => {
    let rejectFirst!: (reason: unknown) => void
    let resolveSecond!: (value: CollectorOutcome) => void
    const collectors: Collector[] = [
      collector(
        "first",
        "openai",
        "subscription",
        () => new Promise((_resolve, reject) => (rejectFirst = reject)),
      ),
      collector(
        "second",
        "anthropic",
        "api_organization",
        () => new Promise((resolve) => (resolveSecond = resolve)),
      ),
    ]
    const service = new QuotaReportService({ collectors, now: () => now })

    const pending = service.generate()
    collectors.splice(0, collectors.length)
    rejectFirst(new Error("secret failure"))
    resolveSecond(outcome("second", "anthropic", "api_organization"))

    const report = await pending
    expect(
      report.sections.flatMap((section) =>
        section.outcomes.map(({ collectorId, state }) => [collectorId, state]),
      ),
    ).toEqual([
      ["first", "unavailable"],
      ["second", "ok"],
    ])
  })

  it("aborts underlying collector work when its timeout expires", async () => {
    vi.useFakeTimers()
    let aborted = false
    const hanging = collector("hanging", "opencode", "local", (signal) => {
      return new Promise((_resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true
        })
      })
    })
    const service = new QuotaReportService({ collectors: [hanging], now: () => now })

    const pending = service.generate()
    await vi.advanceTimersByTimeAsync(5_000)
    const report = await pending

    expect(aborted).toBe(true)
    expect(report.sections[0]?.outcomes[0]).toMatchObject({
      collectorId: "hanging",
      state: "timeout",
    })
  })

  it.each([0, -1, Number.NaN])("rejects invalid timeout %s", (timeoutMs) => {
    expect(
      () => new QuotaReportService({ collectors: [], now: () => now, timeoutMs }),
    ).toThrow("timeoutMs must be a finite positive number")
  })
})
