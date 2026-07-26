export type ProviderId = "openai" | "anthropic" | "opencode"

export type AccountKind = "subscription" | "api_organization" | "local"

export type MetricKind = "allowance_window" | "token_usage" | "cost"

export type MetricUnit = "percent" | "tokens" | "usd"

export type MetricAuthority = "authoritative" | "provider_reported" | "local_record"

export type MetricAcquisition = "official_api" | "consumer_api" | "local_database"

export interface QuotaMetric {
  readonly provider: ProviderId
  readonly accountKind: AccountKind
  readonly kind: MetricKind
  readonly label: string
  readonly used?: number
  readonly remaining?: number
  readonly limit?: number
  readonly unit: MetricUnit
  readonly resetsAt?: Date
  readonly authority: MetricAuthority
  readonly acquisition: MetricAcquisition
  readonly fetchedAt: Date
  readonly warning?: string
}

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
  readonly provider: ProviderId
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
}

export type CollectorResult = CollectorMetricResult | CollectorFailureResult

export interface QuotaCollector {
  readonly id: string
  readonly provider: ProviderId
  readonly accountKind: AccountKind
  collect(): Promise<CollectorResult>
}

export interface QuotaReport {
  readonly generatedAt: Date
  readonly results: readonly CollectorResult[]
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
