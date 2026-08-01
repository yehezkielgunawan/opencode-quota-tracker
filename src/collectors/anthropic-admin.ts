import {
  createCostMetric,
  createTokenUsageMetric,
  type Collector,
  type CollectorOutcome,
} from "../domain/quota.js";
import {
  requestJson,
  type RequestJsonOptions,
  type RequestJsonResult,
} from "../report/http.js";
import { getAdminKeys } from "../runtime/auth.js";

const ANTHROPIC_ALLOWED_HOSTS = ["api.anthropic.com"] as const;
const USAGE_ENDPOINT = "https://api.anthropic.com/v1/organizations/usage_report/messages";
const COST_ENDPOINT = "https://api.anthropic.com/v1/organizations/cost_report";

export type AnthropicAdminRequest = RequestJsonOptions<unknown>;
type AnthropicAdminRequester = (options: AnthropicAdminRequest) => Promise<RequestJsonResult<unknown>>;

export interface AnthropicApiCollectorOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly requestJson?: AnthropicAdminRequester;
  readonly now?: () => Date;
}

interface RecordValue {
  readonly [key: string]: unknown;
}

interface Page {
  readonly data: readonly RecordValue[];
  readonly hasMore: boolean;
  readonly nextPage?: string;
}

interface UsageTotals {
  readonly tokens: number;
}

interface CostTotals {
  readonly usd: number;
}

type PageResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly state: Exclude<CollectorOutcome["state"], "ok" | "stale" | "not_configured">;
      readonly message: string;
    };

function asRecord(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parsePage(value: unknown): Page | undefined {
  const root = asRecord(value);
  if (!root || !Array.isArray(root.data)) return undefined;

  const data: RecordValue[] = [];
  for (const bucketValue of root.data) {
    const bucket = asRecord(bucketValue);
    if (!bucket || !Array.isArray(bucket.results)) return undefined;
    const results = bucket.results.map(asRecord);
    if (results.some((result) => result === undefined)) return undefined;
    data.push({ ...bucket, results: results as RecordValue[] });
  }

  const hasMore = root.has_more ?? false;
  if (typeof hasMore !== "boolean") return undefined;
  const nextPage = root.next_page;
  if (nextPage !== undefined && (typeof nextPage !== "string" || !nextPage.trim())) return undefined;
  if (hasMore && typeof nextPage !== "string") return undefined;

  return {
    data,
    hasMore,
    ...(typeof nextPage === "string" && nextPage.trim() ? { nextPage: nextPage.trim() } : {}),
  };
}

function parseUsageTotals(page: Page): UsageTotals | undefined {
  let tokens = 0;
  for (const bucket of page.data) {
    const results = bucket.results as readonly RecordValue[];
    for (const result of results) {
      const uncachedInput = finiteNonNegative(result.uncached_input_tokens);
      const cacheCreationInput = finiteNonNegative(result.cache_creation_input_tokens);
      const cacheReadInput = finiteNonNegative(result.cache_read_input_tokens);
      const output = finiteNonNegative(result.output_tokens);
      if (
        uncachedInput === undefined ||
        cacheCreationInput === undefined ||
        cacheReadInput === undefined ||
        output === undefined
      ) {
        return undefined;
      }
      tokens += uncachedInput + cacheCreationInput + cacheReadInput + output;
    }
  }
  return { tokens };
}

function parseCostTotals(page: Page): CostTotals | undefined {
  let cents = 0;
  for (const bucket of page.data) {
    const results = bucket.results as readonly RecordValue[];
    for (const result of results) {
      const amount = result.amount;
      const numericAmount =
        typeof amount === "number"
          ? finiteNonNegative(amount)
          : typeof amount === "string" && amount.trim()
            ? finiteNonNegative(Number(amount))
            : undefined;
      const currency = typeof result.currency === "string" ? result.currency.toLowerCase() : undefined;
      if (numericAmount === undefined || currency !== "usd") return undefined;
      cents += numericAmount;
    }
  }
  return { usd: cents / 100 };
}

function buildEndpointUrl(
  endpoint: string,
  start: Date,
  end: Date,
  groupBy: string,
  cursor?: string,
): string {
  const url = new URL(endpoint);
  url.searchParams.set("starting_at", start.toISOString());
  url.searchParams.set("ending_at", end.toISOString());
  url.searchParams.set("bucket_width", "1d");
  url.searchParams.append("group_by[]", groupBy);
  if (cursor) url.searchParams.set("page", cursor);
  return url.toString();
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
    accountKind: "api_organization",
    state,
    fetchedAt,
    message,
  };
}

export class AnthropicApiCollector implements Collector {
  readonly id = "anthropic-admin";
  readonly provider = "anthropic" as const;
  readonly accountKind = "api_organization" as const;

  private readonly env: NodeJS.ProcessEnv;
  private readonly request: AnthropicAdminRequester;
  private readonly now: () => Date;

  constructor(options: AnthropicApiCollectorOptions = {}) {
    this.env = options.env ?? process.env;
    this.request = options.requestJson ?? ((request) => requestJson(request));
    this.now = options.now ?? (() => new Date());
  }

  async collect(signal: AbortSignal): Promise<CollectorOutcome> {
    const fetchedAt = this.now();
    const adminKey = getAdminKeys(this.env).anthropic;
    if (!adminKey) {
      return safeFailure(this.id, "not_configured", fetchedAt, "Anthropic Admin API key is not configured.");
    }
    if (signal.aborted) return safeFailure(this.id, "timeout", fetchedAt, "Anthropic Admin collection was cancelled.");

    const start = new Date(Date.UTC(fetchedAt.getUTCFullYear(), fetchedAt.getUTCMonth(), 1));
    const headers = {
      "x-api-key": adminKey,
      "anthropic-version": "2023-06-01",
    };
    const usage = await this.fetchAllPages<UsageTotals>({
      endpoint: USAGE_ENDPOINT,
      start,
      end: fetchedAt,
      groupBy: "model",
      headers,
      signal,
      parse: parseUsageTotals,
      combine: (left, right) => ({ tokens: left.tokens + right.tokens }),
    });
    if (!usage.ok) return safeFailure(this.id, usage.state, fetchedAt, usage.message);

    const costs = await this.fetchAllPages<CostTotals>({
      endpoint: COST_ENDPOINT,
      start,
      end: fetchedAt,
      groupBy: "description",
      headers,
      signal,
      parse: parseCostTotals,
      combine: (left, right) => ({ usd: left.usd + right.usd }),
    });
    if (!costs.ok) return safeFailure(this.id, costs.state, fetchedAt, costs.message);

    const metrics = [];
    if (usage.value.tokens > 0) {
      metrics.push(
        createTokenUsageMetric({
          provider: "anthropic",
          accountKind: "api_organization",
          label: "Month · Anthropic API messages",
          used: usage.value.tokens,
          authority: "authoritative",
          acquisition: "official_api",
          fetchedAt,
        }),
      );
    }
    if (costs.value.usd > 0) {
      metrics.push(
        createCostMetric({
          provider: "anthropic",
          accountKind: "api_organization",
          label: "Month · Anthropic API cost",
          used: costs.value.usd,
          authority: "authoritative",
          acquisition: "official_api",
          fetchedAt,
        }),
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

  private async fetchAllPages<T>(options: {
    readonly endpoint: string;
    readonly start: Date;
    readonly end: Date;
    readonly groupBy: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
    readonly parse: (page: Page) => T | undefined;
    readonly combine: (left: T, right: T) => T;
  }): Promise<PageResult<T>> {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    let total: T | undefined;

    while (true) {
      if (options.signal.aborted) {
        return { ok: false, state: "timeout", message: "Anthropic Admin collection was cancelled." };
      }
      if (cursor && seenCursors.has(cursor)) {
        return { ok: false, state: "unsupported_response", message: "Anthropic Admin pagination is invalid." };
      }
      if (cursor) seenCursors.add(cursor);

      let response: RequestJsonResult<unknown>;
      try {
        response = await this.request({
          url: buildEndpointUrl(options.endpoint, options.start, options.end, options.groupBy, cursor),
          allowedHosts: ANTHROPIC_ALLOWED_HOSTS,
          headers: options.headers,
          signal: options.signal,
        });
      } catch {
        return { ok: false, state: "unavailable", message: "Anthropic Admin request failed." };
      }
      if (!response.ok) return response;

      const page = parsePage(response.data);
      if (!page) return { ok: false, state: "unsupported_response", message: "Anthropic Admin response is unsupported." };
      const parsed = options.parse(page);
      if (!parsed) return { ok: false, state: "unsupported_response", message: "Anthropic Admin response is unsupported." };

      total = total === undefined ? parsed : options.combine(total, parsed);
      if (!page.hasMore) return { ok: true, value: total };
      if (!page.nextPage) {
        return { ok: false, state: "unsupported_response", message: "Anthropic Admin pagination is invalid." };
      }
      cursor = page.nextPage;
    }
  }
}
