import { describe, expect, expectTypeOf, it } from "vitest"

import { clampPercent, remainingFromUsed } from "../../src/core/quota"
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

    const invalidFailure: CollectorResult = {
      ...failure,
      // @ts-expect-error Failed results must not expose synthetic metrics.
      metrics: [],
    }
    void invalidFailure
  })
})
