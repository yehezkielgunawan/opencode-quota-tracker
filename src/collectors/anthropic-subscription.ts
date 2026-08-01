import {
  createAllowanceMetric,
  type Collector,
  type CollectorOutcome,
} from "../domain/quota.js";
import {
  requestJson,
  type RequestJsonOptions,
  type RequestJsonResult,
} from "../report/http.js";
import { loadClaudeAuth, type ClaudeAuthResult } from "../runtime/auth.js";

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_ALLOWED_HOSTS = ["api.anthropic.com"] as const;
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

export type AnthropicSubscriptionRequest = RequestJsonOptions<unknown>;
type AnthropicSubscriptionRequester = (
  options: AnthropicSubscriptionRequest,
) => Promise<RequestJsonResult<unknown>>;

export interface AnthropicSubscriptionCollectorOptions {
  readonly auth?: () => Promise<ClaudeAuthResult>;
  readonly requestJson?: AnthropicSubscriptionRequester;
  readonly now?: () => Date;
}

interface RawRecord {
  readonly [key: string]: unknown;
}

function asRecord(value: unknown): RawRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RawRecord)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstNumber(record: RawRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = finiteNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function asPercent(value: number, fraction: boolean): number | undefined {
  const percent = fraction ? value * 100 : value;
  return percent >= 0 && percent <= 100 ? percent : undefined;
}

function resetTime(record: RawRecord): Date | undefined {
  const raw = record.resets_at ?? record.reset_at ?? record.resetsAt ?? record.resetAt;
  if (typeof raw === "string" && raw.trim()) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  const numeric = finiteNumber(raw);
  if (numeric === undefined || numeric <= 0) return undefined;
  const date = new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseWindow(
  raw: unknown,
  label: string,
  fetchedAt: Date,
): ReturnType<typeof createAllowanceMetric> | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;

  const utilization = firstNumber(record, ["utilization", "utilisation", "usage_fraction"]);
  const used =
    utilization === undefined
      ? asPercent(firstNumber(record, ["used_percentage", "used_percent", "usedPercent", "used"]) ?? NaN, false)
      : asPercent(utilization, utilization >= 0 && utilization <= 1);
  const remaining = asPercent(
    firstNumber(record, ["remaining_percentage", "remaining_percent", "remainingPercent", "remaining"]) ?? NaN,
    false,
  );

  if (used === undefined && remaining === undefined) return undefined;

  const resetsAt = resetTime(record);
  const base = {
    provider: "anthropic" as const,
    accountKind: "subscription" as const,
    label,
    authority: "provider_reported" as const,
    acquisition: "consumer_api" as const,
    fetchedAt,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };

  try {
    return used === undefined
      ? createAllowanceMetric({ ...base, remaining: remaining! })
      : createAllowanceMetric({ ...base, used, ...(remaining === undefined ? {} : { remaining }) });
  } catch {
    return undefined;
  }
}

function parseUsageMetrics(data: unknown, fetchedAt: Date) {
  const root = asRecord(data);
  const usage = asRecord(root?.usage) ?? root;
  if (!usage) return [];

  const metrics = [
    parseWindow(usage.five_hour ?? usage.fiveHour ?? usage.five_hour_window, "Five-hour allowance", fetchedAt),
    parseWindow(usage.seven_day ?? usage.sevenDay ?? usage.seven_day_window, "Seven-day allowance", fetchedAt),
  ];
  return metrics.filter((metric): metric is NonNullable<typeof metric> => metric !== undefined);
}

function safeFailure(
  collectorId: string,
  state: Exclude<CollectorOutcome["state"], "ok" | "stale">,
  fetchedAt: Date,
  message: string,
): CollectorOutcome {
  return {
    collectorId,
    provider: "anthropic",
    accountKind: "subscription",
    state,
    fetchedAt,
    message,
  };
}

export class AnthropicSubscriptionCollector implements Collector {
  readonly id = "anthropic-subscription";
  readonly provider = "anthropic" as const;
  readonly accountKind = "subscription" as const;

  private readonly auth: () => Promise<ClaudeAuthResult>;
  private readonly request: AnthropicSubscriptionRequester;
  private readonly now: () => Date;

  constructor(options: AnthropicSubscriptionCollectorOptions = {}) {
    this.auth = options.auth ?? loadClaudeAuth;
    this.request = options.requestJson ?? ((request) => requestJson(request));
    this.now = options.now ?? (() => new Date());
  }

  async collect(signal: AbortSignal): Promise<CollectorOutcome> {
    const fetchedAt = this.now();
    if (signal.aborted) {
      return safeFailure(this.id, "timeout", fetchedAt, "Anthropic subscription collection was cancelled.");
    }

    let auth: ClaudeAuthResult;
    try {
      auth = await this.auth();
    } catch {
      return safeFailure(this.id, "unavailable", fetchedAt, "Claude authentication could not be read.");
    }
    if (auth.state !== "configured") return safeFailure(this.id, auth.state, fetchedAt, auth.message);
    if (signal.aborted) {
      return safeFailure(this.id, "timeout", fetchedAt, "Anthropic subscription collection was cancelled.");
    }

    let response: RequestJsonResult<unknown>;
    try {
      response = await this.request({
        url: ANTHROPIC_USAGE_URL,
        allowedHosts: ANTHROPIC_ALLOWED_HOSTS,
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          "anthropic-beta": ANTHROPIC_OAUTH_BETA,
        },
        signal,
      });
    } catch {
      return safeFailure(this.id, "unavailable", fetchedAt, "Anthropic subscription request failed.");
    }

    if (!response.ok) return safeFailure(this.id, response.state, fetchedAt, response.message);

    const metrics = parseUsageMetrics(response.data, fetchedAt);
    if (metrics.length === 0) {
      return safeFailure(
        this.id,
        "unsupported_response",
        fetchedAt,
        "Anthropic subscription response has no valid allowance windows.",
      );
    }

    return {
      collectorId: this.id,
      provider: this.provider,
      accountKind: this.accountKind,
      state: "ok",
      fetchedAt,
      metrics,
    };
  }
}
