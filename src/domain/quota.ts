export type Provider = "openai" | "anthropic" | "opencode"

export type ProviderId = Provider

export type AccountKind = "subscription" | "api_organization" | "local"

export type MetricKind = "allowance_window" | "token_usage" | "cost"

export type MetricUnit = "percent" | "tokens" | "usd"

export type Authority = "authoritative" | "provider_reported" | "local_record"

export type MetricAuthority = Authority

export type Acquisition = "official_api" | "consumer_api" | "local_database"

export type MetricAcquisition = Acquisition

interface QuotaMetricBase {
  readonly provider: Provider
  readonly accountKind: AccountKind
  readonly label: string
  readonly resetsAt?: Date
  readonly authority: Authority
  readonly acquisition: Acquisition
  readonly fetchedAt: Date
  readonly warning?: string
}

type AllowanceMetricInputValues =
  | {
      readonly used: number
      readonly remaining?: number
      readonly limit?: number
    }
  | {
      readonly used?: number
      readonly remaining: number
      readonly limit?: number
    }

export interface AllowanceWindowMetric extends QuotaMetricBase {
  readonly kind: "allowance_window"
  readonly unit: "percent"
  readonly used: number
  readonly remaining: number
  readonly limit: number
}

export interface TokenUsageMetric extends QuotaMetricBase {
  readonly kind: "token_usage"
  readonly unit: "tokens"
  readonly used: number
  readonly remaining?: number
  readonly limit?: number
}

export interface CostMetric extends QuotaMetricBase {
  readonly kind: "cost"
  readonly unit: "usd"
  readonly used: number
  readonly remaining?: number
  readonly limit?: number
}

export type QuotaMetric = AllowanceWindowMetric | TokenUsageMetric | CostMetric

export type CollectorState =
  | "ok"
  | "not_configured"
  | "unavailable"
  | "unauthorized"
  | "rate_limited"
  | "timeout"
  | "unsupported_response"
  | "stale"

interface CollectorResultBase {
  readonly collectorId: string
  readonly provider: Provider
  readonly accountKind: AccountKind
  readonly fetchedAt: Date
}

type CollectorMetricResult = CollectorResultBase &
  (
    | {
        readonly state: "ok"
        readonly metrics: readonly QuotaMetric[]
      }
    | {
        readonly state: "stale"
        readonly metrics: readonly QuotaMetric[]
        readonly message?: string
        readonly warning?: string
      }
  )

type CollectorFailureResult = CollectorResultBase & {
  readonly state: Exclude<CollectorState, "ok" | "stale">
  readonly message: string
  readonly metrics?: never
}

export type CollectorOutcome = CollectorMetricResult | CollectorFailureResult

export type CollectorResult = CollectorOutcome

export interface Collector {
  readonly id: string
  readonly provider: Provider
  readonly accountKind: AccountKind
  collect(signal: AbortSignal): Promise<CollectorOutcome>
}

export type QuotaCollector = Collector

export interface QuotaSection {
  readonly provider: Provider
  readonly accountKind: AccountKind
  readonly outcomes: readonly CollectorOutcome[]
}

export interface QuotaReport {
  readonly generatedAt: Date
  readonly sections: readonly QuotaSection[]
}

type AllowanceMetricInput = QuotaMetricBase & AllowanceMetricInputValues

interface UsageMetricInput extends QuotaMetricBase {
  readonly used: number
  readonly remaining?: number
  readonly limit?: number
}

function assertNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`)
  }
}

function validateUsageInput(input: UsageMetricInput): void {
  assertNonNegative("used", input.used)

  for (const field of ["remaining", "limit"] as const) {
    const value = input[field]
    if (value !== undefined) assertNonNegative(field, value)
  }
}

export function createAllowanceMetric(input: AllowanceMetricInput): AllowanceWindowMetric {
  if (input.used === undefined && input.remaining === undefined) {
    throw new TypeError("Allowance metrics require used or remaining")
  }

  const limit = clampPercent(input.limit ?? 100)

  if (input.used !== undefined) {
    const used = clampPercent(input.used)
    const remaining =
      input.remaining === undefined ? remainingFromUsed(used) : clampPercent(input.remaining)

    return { ...input, limit, used, remaining, kind: "allowance_window", unit: "percent" }
  }

  if (input.remaining !== undefined) {
    const remaining = clampPercent(input.remaining)
    const used = 100 - remaining

    return { ...input, limit, used, remaining, kind: "allowance_window", unit: "percent" }
  }

  throw new TypeError("Allowance metrics require used or remaining")
}

export function createTokenUsageMetric(input: UsageMetricInput): TokenUsageMetric {
  validateUsageInput(input)

  return { ...input, kind: "token_usage", unit: "tokens" }
}

export function createCostMetric(input: UsageMetricInput): CostMetric {
  validateUsageInput(input)

  return { ...input, kind: "cost", unit: "usd" }
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError("Percentage must be finite")
  }

  return Math.min(100, Math.max(0, value))
}

export function remainingFromUsed(used: number): number {
  return 100 - clampPercent(used)
}
