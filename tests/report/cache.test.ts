import { describe, expect, it, vi } from "vitest"

import type { CollectorOutcome } from "../../src/domain/quota.js"
import { SuccessCache } from "../../src/report/cache.js"

const fetchedAt = new Date("2026-07-31T00:00:00.000Z")

function success(at = fetchedAt): Extract<CollectorOutcome, { state: "ok" }> {
  return {
    collectorId: "openai-subscription",
    provider: "openai",
    accountKind: "subscription",
    state: "ok",
    fetchedAt: at,
    metrics: [],
  }
}

function failure(state: "unavailable" | "not_configured"): CollectorOutcome {
  return {
    collectorId: "openai-subscription",
    provider: "openai",
    accountKind: "subscription",
    state,
    fetchedAt: new Date("2026-07-31T00:10:00.000Z"),
    message: "safe failure",
  }
}

describe("SuccessCache", () => {
  it.each([-1, Number.NaN])("rejects invalid fresh TTL %s", (freshForMs) => {
    expect(() => new SuccessCache({ now: () => 0, freshForMs })).toThrow(
      "freshForMs must be a finite non-negative number",
    )
  })

  it("returns a successful value without refreshing for five minutes", async () => {
    let now = 0
    const cache = new SuccessCache({ now: () => now })
    const refresh = vi.fn().mockResolvedValue(success())

    await expect(cache.get("account", refresh)).resolves.toEqual(success())
    now = 299_999
    await expect(cache.get("account", refresh)).resolves.toEqual(success())

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("refreshes an expired successful value", async () => {
    let now = 0
    const cache = new SuccessCache({ now: () => now })
    const refreshed = success(new Date("2026-07-31T00:05:00.000Z"))
    const refresh = vi.fn().mockResolvedValueOnce(success()).mockResolvedValueOnce(refreshed)

    await cache.get("account", refresh)
    now = 300_000

    await expect(cache.get("account", refresh)).resolves.toEqual(refreshed)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it("deduplicates concurrent refreshes for one key", async () => {
    const cache = new SuccessCache({ now: () => 0 })
    let resolveRefresh!: (value: Extract<CollectorOutcome, { state: "ok" }>) => void
    const refresh = vi.fn(
      () =>
        new Promise<Extract<CollectorOutcome, { state: "ok" }>>((resolve) => {
          resolveRefresh = resolve
        }),
    )

    const first = cache.get("account", refresh)
    const second = cache.get("account", refresh)
    resolveRefresh(success())

    await expect(Promise.all([first, second])).resolves.toEqual([success(), success()])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("returns the prior success as stale after a transient refresh failure", async () => {
    let now = 0
    const cache = new SuccessCache({ now: () => now })
    const refresh = vi.fn().mockResolvedValueOnce(success()).mockResolvedValueOnce(failure("unavailable"))

    await cache.get("account", refresh)
    now = 300_000

    await expect(cache.get("account", refresh)).resolves.toEqual({
      ...success(),
      state: "stale",
      message: "Cached quota data is stale.",
      warning: "Refresh failed; showing the last successful result.",
    })
  })

  it("returns the prior success as stale when refresh rejects", async () => {
    let now = 0
    const cache = new SuccessCache({ now: () => now })
    const refresh = vi
      .fn<() => Promise<CollectorOutcome>>()
      .mockResolvedValueOnce(success())
      .mockRejectedValueOnce(new Error("Bearer refresh-secret"))

    await cache.get("account", refresh)
    now = 300_000
    const result = await cache.get("account", refresh)

    expect(result).toEqual({
      ...success(),
      state: "stale",
      message: "Cached quota data is stale.",
      warning: "Refresh failed; showing the last successful result.",
    })
    expect(JSON.stringify(result)).not.toMatch(/Bearer|refresh-secret/)
  })

  it("preserves refresh rejection when no prior success exists", async () => {
    const cache = new SuccessCache({ now: () => 0 })
    const error = new Error("refresh failed")

    await expect(cache.get("account", async () => Promise.reject(error))).rejects.toBe(error)
  })

  it("does not cache unsuccessful outcomes as successful data", async () => {
    const cache = new SuccessCache({ now: () => 0 })
    const refresh = vi
      .fn<() => Promise<CollectorOutcome>>()
      .mockResolvedValueOnce(failure("not_configured"))
      .mockResolvedValueOnce(success())

    await expect(cache.get("account", refresh)).resolves.toEqual(failure("not_configured"))
    await expect(cache.get("account", refresh)).resolves.toEqual(success())
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
