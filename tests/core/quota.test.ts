import { describe, expect, expectTypeOf, it } from "vitest"

import {
  clampPercent,
  createAllowanceMetric,
  createCostMetric,
  createTokenUsageMetric,
  remainingFromUsed,
} from "../../src/core/quota"
import type {
  AccountKind,
  CollectorResult,
  CollectorState,
  MetricAcquisition,
  MetricAuthority,
  MetricKind,
  MetricUnit,
  ProviderId,
  QuotaCollector,
  QuotaMetric,
  QuotaReport,
} from "../../src/core/quota"

describe("clampPercent", () => {
  it.each([0, 42.5, 100])("preserves an in-range percentage: %s", (value) => {
    expect(clampPercent(value)).toBe(value)
  })

  it.each([
    [-0.1, 0],
    [-100, 0],
    [100.1, 100],
    [250, 100],
  ])("clamps %s to %s", (value, expected) => {
    expect(clampPercent(value)).toBe(expected)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects a non-finite percentage: %s",
    (value) => {
      expect(() => clampPercent(value)).toThrow(TypeError)
    },
  )
})

describe("remainingFromUsed", () => {
  it.each([
    [0, 100],
    [12.5, 87.5],
    [100, 0],
    [-10, 100],
    [110, 0],
  ])("converts used percentage %s to remaining percentage %s", (used, expected) => {
    expect(remainingFromUsed(used)).toBe(expected)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects a non-finite used percentage: %s",
    (used) => {
      expect(() => remainingFromUsed(used)).toThrow(TypeError)
    },
  )
})

describe("quota metric constructors", () => {
  const metricBase = {
    provider: "openai" as const,
    accountKind: "subscription" as const,
    label: "Current quota",
    authority: "provider_reported" as const,
    acquisition: "consumer_api" as const,
    fetchedAt: new Date("2026-07-26T12:00:00.000Z"),
  }

  it("creates allowance metrics with a fixed percent discriminator", () => {
    expect(createAllowanceMetric({ ...metricBase, used: 25, remaining: 75 })).toEqual({
      ...metricBase,
      used: 25,
      remaining: 75,
      kind: "allowance_window",
      unit: "percent",
    })
  })

  it("rejects an allowance metric without a numeric value", () => {
    const input = metricBase as unknown as Parameters<typeof createAllowanceMetric>[0]

    expect(() => createAllowanceMetric(input)).toThrow(TypeError)
  })

  it.each([
    ["used", Number.NaN],
    ["remaining", Number.POSITIVE_INFINITY],
    ["limit", -1],
    ["used", 100.1],
  ] as const)("rejects invalid allowance %s value %s", (field, value) => {
    const input = { ...metricBase, [field]: value } as unknown as Parameters<
      typeof createAllowanceMetric
    >[0]

    expect(() => createAllowanceMetric(input)).toThrow(TypeError)
  })

  it("accepts a provider percentage only after explicit clamping", () => {
    expect(createAllowanceMetric({ ...metricBase, used: clampPercent(112) }).used).toBe(100)
  })

  it("creates token and cost metrics with fixed discriminators", () => {
    expect(createTokenUsageMetric({ ...metricBase, used: 1_000 })).toMatchObject({
      kind: "token_usage",
      unit: "tokens",
      used: 1_000,
    })
    expect(createCostMetric({ ...metricBase, used: 12.5 })).toMatchObject({
      kind: "cost",
      unit: "usd",
      used: 12.5,
    })
  })

  it.each([createTokenUsageMetric, createCostMetric])(
    "rejects a usage metric without a used amount",
    (createMetric) => {
      const input = metricBase as unknown as Parameters<typeof createMetric>[0]

      expect(() => createMetric(input)).toThrow(TypeError)
    },
  )

  it.each([
    [createTokenUsageMetric, "used", -1],
    [createTokenUsageMetric, "remaining", Number.NaN],
    [createTokenUsageMetric, "limit", Number.POSITIVE_INFINITY],
    [createCostMetric, "used", Number.NEGATIVE_INFINITY],
    [createCostMetric, "remaining", -0.01],
    [createCostMetric, "limit", Number.NaN],
  ] as const)("rejects invalid usage values", (createMetric, field, value) => {
    const input = { ...metricBase, used: 1, [field]: value }

    expect(() => createMetric(input)).toThrow(TypeError)
  })
})

describe("quota domain model", () => {
  it("defines the normalized provider and metric vocabulary", () => {
    expectTypeOf<ProviderId>().toEqualTypeOf<"openai" | "anthropic" | "opencode">()
    expectTypeOf<AccountKind>().toEqualTypeOf<
      "subscription" | "api_organization" | "local"
    >()
    expectTypeOf<MetricKind>().toEqualTypeOf<
      "allowance_window" | "token_usage" | "cost"
    >()
    expectTypeOf<MetricUnit>().toEqualTypeOf<"percent" | "tokens" | "usd">()
    expectTypeOf<MetricAuthority>().toEqualTypeOf<
      "authoritative" | "provider_reported" | "local_record"
    >()
    expectTypeOf<MetricAcquisition>().toEqualTypeOf<
      "official_api" | "consumer_api" | "local_database"
    >()
    expectTypeOf<CollectorState>().toEqualTypeOf<
      | "ok"
      | "not_configured"
      | "unavailable"
      | "unauthorized"
      | "rate_limited"
      | "timeout"
      | "unsupported_response"
      | "stale"
    >()
  })

  it("represents successful and failed collections without invented metrics", async () => {
    const fetchedAt = new Date("2026-07-26T12:00:00.000Z")
    const metric: QuotaMetric = {
      provider: "openai",
      accountKind: "subscription",
      kind: "allowance_window",
      label: "Five-hour window",
      used: 25,
      remaining: 75,
      limit: 100,
      unit: "percent",
      resetsAt: new Date("2026-07-26T15:00:00.000Z"),
      authority: "provider_reported",
      acquisition: "consumer_api",
      fetchedAt,
    }
    const success: CollectorResult = {
      collectorId: "openai-subscription",
      provider: "openai",
      accountKind: "subscription",
      state: "ok",
      fetchedAt,
      metrics: [metric],
    }
    const failure: CollectorResult = {
      collectorId: "anthropic-api",
      provider: "anthropic",
      accountKind: "api_organization",
      state: "unauthorized",
      fetchedAt,
      message: "Authentication is required",
    }
    const stale: CollectorResult = {
      ...success,
      state: "stale",
      message: "Using the last successful response",
    }
    const report: QuotaReport = {
      generatedAt: fetchedAt,
      results: [success, failure, stale],
    }
    const collector: QuotaCollector = {
      id: "openai-subscription",
      provider: "openai",
      accountKind: "subscription",
      async collect() {
        return success
      },
    }

    const collected = await collector.collect()
    expect(collected.state).toBe("ok")
    if (collected.state !== "ok") throw new Error("Expected an ok collector result")
    expect(collected.metrics).toEqual([metric])
    expect(failure.message).toBe("Authentication is required")
    expect("metrics" in failure).toBe(false)
    expect(stale.metrics).toEqual([metric])
    expect(report.results.map((result) => result.collectorId)).toEqual([
      "openai-subscription",
      "anthropic-api",
      "openai-subscription",
    ])

  })

  it("rejects structurally invalid metric and result variables", () => {
    const sharedMetric = {
      provider: "openai" as const,
      accountKind: "subscription" as const,
      label: "Invalid metric",
      authority: "provider_reported" as const,
      acquisition: "consumer_api" as const,
      fetchedAt: new Date("2026-07-26T12:00:00.000Z"),
    }
    const mismatchedKindAndUnit = {
      ...sharedMetric,
      kind: "allowance_window" as const,
      unit: "tokens" as const,
      used: 10,
    }
    const allowanceWithoutValue = {
      ...sharedMetric,
      kind: "allowance_window" as const,
      unit: "percent" as const,
    }
    const tokenUsageWithoutUsed = {
      ...sharedMetric,
      kind: "token_usage" as const,
      unit: "tokens" as const,
    }
    const failureWithMetrics = {
      collectorId: "openai-subscription",
      provider: "openai" as const,
      accountKind: "subscription" as const,
      state: "timeout" as const,
      fetchedAt: new Date("2026-07-26T12:00:00.000Z"),
      message: "Collector timed out",
      metrics: [] as const,
    }

    // @ts-expect-error Metric kind and unit must be paired.
    const invalidPair: QuotaMetric = mismatchedKindAndUnit
    // @ts-expect-error Allowance metrics must contain at least one numeric value.
    const invalidAllowance: QuotaMetric = allowanceWithoutValue
    // @ts-expect-error Token usage metrics require a used amount.
    const invalidTokenUsage: QuotaMetric = tokenUsageWithoutUsed
    // @ts-expect-error Failure results cannot contain metrics, including through variables.
    const invalidFailure: CollectorResult = failureWithMetrics

    void [invalidPair, invalidAllowance, invalidTokenUsage, invalidFailure]
  })
})
