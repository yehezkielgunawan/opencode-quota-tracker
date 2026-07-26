import { describe, expect, it } from "vitest"

import { formatResetCountdown, formatTokens, formatUsd } from "../../src/domain/format"

describe("formatTokens", () => {
  it("formats integer token counts with deterministic US separators", () => {
    expect(formatTokens(1_234_567)).toBe("1,234,567")
  })
})

describe("formatUsd", () => {
  it("formats USD with fixed currency precision", () => {
    expect(formatUsd(12.5)).toBe("$12.50")
    expect(formatUsd(0)).toBe("$0.00")
  })
})

describe("formatResetCountdown", () => {
  const now = new Date("2026-07-26T12:00:00.000Z")

  it.each([
    [new Date("2026-07-28T15:00:00.000Z"), "2d 3h"],
    [new Date("2026-07-26T16:12:00.000Z"), "4h 12m"],
    [new Date("2026-07-26T12:08:00.000Z"), "8m"],
  ])("formats a future reset using the largest meaningful pair", (resetsAt, expected) => {
    expect(formatResetCountdown(resetsAt, now)).toBe(expected)
  })

  it.each([
    [new Date("2026-07-26T12:00:00.000Z"), "now"],
    [new Date("2026-07-26T11:59:00.000Z"), "now"],
  ])("formats current or expired resets as now", (resetsAt, expected) => {
    expect(formatResetCountdown(resetsAt, now)).toBe(expected)
  })

  it.each([new Date(Number.NaN), Number.NaN, Number.POSITIVE_INFINITY])(
    "returns an explicit fallback for an invalid reset timestamp",
    (resetsAt) => {
      expect(formatResetCountdown(resetsAt, now)).toBe("unknown")
    },
  )

  it("accepts epoch timestamps for both reset and injected now", () => {
    expect(formatResetCountdown(now.getTime() + 60_000, now.getTime())).toBe("1m")
  })
})
