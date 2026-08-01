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
import { loadOpenCodeAuth, type OpenAIAuthResult } from "../runtime/auth.js";

const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENAI_ALLOWED_HOSTS = ["chatgpt.com"] as const;

export type OpenAISubscriptionRequest = RequestJsonOptions<unknown>;
type OpenAISubscriptionRequester = (
  options: OpenAISubscriptionRequest,
) => Promise<RequestJsonResult<unknown>>;

export interface OpenAISubscriptionCollectorOptions {
  readonly auth?: () => Promise<OpenAIAuthResult>;
  readonly requestJson?: OpenAISubscriptionRequester;
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

function formatWindowDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function resetTime(raw: RawRecord, now: Date): Date | undefined {
  const resetAt = finiteNumber(raw.reset_at);
  if (resetAt !== undefined && resetAt > 0) {
    const date = new Date(resetAt * 1_000);
    if (!Number.isNaN(date.getTime())) return date;
  }

  const resetAfter = finiteNumber(raw.reset_after_seconds);
  if (resetAfter !== undefined && resetAfter > 0) {
    const date = new Date(now.getTime() + resetAfter * 1_000);
    if (!Number.isNaN(date.getTime())) return date;
  }

  return undefined;
}

function parseWindow(
  raw: unknown,
  label: string,
  fetchedAt: Date,
): ReturnType<typeof createAllowanceMetric> | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;

  const duration = finiteNumber(record.limit_window_seconds);
  if (duration === undefined || duration <= 0) return undefined;

  const used = finiteNumber(record.used_percent);
  const remaining = finiteNumber(record.remaining_percent);
  if (used === undefined && remaining === undefined) return undefined;

  const resetsAt = resetTime(record, fetchedAt);
  const base = {
    provider: "openai" as const,
    accountKind: "subscription" as const,
    label: `${label} · ${formatWindowDuration(duration)} window`,
    authority: "provider_reported" as const,
    acquisition: "consumer_api" as const,
    fetchedAt,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };

  try {
    if (used !== undefined) {
      return createAllowanceMetric({
        ...base,
        used,
        ...(remaining === undefined ? {} : { remaining }),
      });
    }

    return createAllowanceMetric({ ...base, remaining: remaining! });
  } catch {
    return undefined;
  }
}

function safeFailure(
  collectorId: string,
  state: Exclude<CollectorOutcome["state"], "ok" | "stale">,
  fetchedAt: Date,
  message: string,
): CollectorOutcome {
  return {
    collectorId,
    provider: "openai",
    accountKind: "subscription",
    state,
    fetchedAt,
    message,
  };
}

function mapRequestFailure(
  collectorId: string,
  result: Extract<RequestJsonResult<unknown>, { ok: false }>,
  fetchedAt: Date,
): CollectorOutcome {
  return safeFailure(collectorId, result.state, fetchedAt, result.message);
}

function parseUsageMetrics(data: unknown, fetchedAt: Date) {
  const root = asRecord(data);
  const rateLimit = asRecord(root?.rate_limit);
  if (!rateLimit) return [];

  const metrics = [
    parseWindow(rateLimit.primary_window, "Primary", fetchedAt),
    parseWindow(rateLimit.secondary_window, "Secondary", fetchedAt),
  ];
  return metrics.filter((metric): metric is NonNullable<typeof metric> => metric !== undefined);
}

export class OpenAISubscriptionCollector implements Collector {
  readonly id = "openai-subscription";
  readonly provider = "openai" as const;
  readonly accountKind = "subscription" as const;

  private readonly auth: () => Promise<OpenAIAuthResult>;
  private readonly request: OpenAISubscriptionRequester;
  private readonly now: () => Date;

  constructor(options: OpenAISubscriptionCollectorOptions = {}) {
    this.auth = options.auth ?? loadOpenCodeAuth;
    this.request = options.requestJson ?? ((request) => requestJson(request));
    this.now = options.now ?? (() => new Date());
  }

  async collect(signal: AbortSignal): Promise<CollectorOutcome> {
    const fetchedAt = this.now();
    if (signal.aborted) return safeFailure(this.id, "timeout", fetchedAt, "OpenAI quota collection was cancelled.");

    let auth: OpenAIAuthResult;
    try {
      auth = await this.auth();
    } catch {
      return safeFailure(this.id, "unavailable", fetchedAt, "OpenAI authentication could not be read.");
    }

    if (auth.state !== "configured") {
      return safeFailure(this.id, auth.state, fetchedAt, auth.message);
    }
    if (signal.aborted) return safeFailure(this.id, "timeout", fetchedAt, "OpenAI quota collection was cancelled.");

    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.accessToken}`,
    };
    if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;

    let response: RequestJsonResult<unknown>;
    try {
      response = await this.request({
        url: OPENAI_USAGE_URL,
        allowedHosts: OPENAI_ALLOWED_HOSTS,
        headers,
        signal,
      });
    } catch {
      return safeFailure(this.id, "unavailable", fetchedAt, "OpenAI quota request failed.");
    }

    if (!response.ok) return mapRequestFailure(this.id, response, fetchedAt);

    const metrics = parseUsageMetrics(response.data, fetchedAt);
    if (metrics.length === 0) {
      return safeFailure(this.id, "unsupported_response", fetchedAt, "OpenAI quota response has no valid windows.");
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
