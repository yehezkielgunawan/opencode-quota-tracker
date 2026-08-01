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

const OPENAI_ALLOWED_HOSTS = ["api.openai.com"] as const;
const USAGE_ENDPOINT = "https://api.openai.com/v1/organization/usage/completions";
const COST_ENDPOINT = "https://api.openai.com/v1/organization/costs";

export type OpenAIAdminRequest = RequestJsonOptions<unknown>;
type OpenAIAdminRequester = (
  options: OpenAIAdminRequest,
) => Promise<RequestJsonResult<unknown>>;

export interface OpenAIApiCollectorOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly requestJson?: OpenAIAdminRequester;
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
  | { readonly ok: false; readonly state: Exclude<CollectorOutcome["state"], "ok" | "stale" | "not_configured">; readonly message: string };

function asRecord(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalFiniteNonNegative(record: RecordValue, key: string): boolean {
  if (!(key in record)) return true;
  return finiteNonNegative(record[key]) !== undefined;
}

function parsePage(value: unknown): Page | undefined {
  const root = asRecord(value);
  if (!root || !Array.isArray(root.data)) return undefined;

  const data: RecordValue[] = [];
  for (const bucketValue of root.data) {
    const bucket = asRecord(bucketValue);
    if (!bucket || !Array.isArray(bucket.result)) return undefined;
    const results = bucket.result.map(asRecord);
    if (results.some((result) => result === undefined)) return undefined;
    data.push({ ...bucket, result: results as RecordValue[] });
  }

  const hasMore = root.has_more ?? false;
  if (typeof hasMore !== "boolean") return undefined;

  const nextPage = root.next_page;
  if (nextPage !== undefined && (typeof nextPage !== "string" || !nextPage.trim())) {
    return undefined;
  }
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
    const results = bucket.result as readonly RecordValue[];
    for (const result of results) {
      const input = finiteNonNegative(result.input_tokens);
      const output = finiteNonNegative(result.output_tokens);
      if (input === undefined || output === undefined) return undefined;
      if (
        !optionalFiniteNonNegative(result, "input_cached_tokens") ||
        !optionalFiniteNonNegative(result, "output_reasoning_tokens") ||
        !optionalFiniteNonNegative(result, "num_model_requests")
      ) {
        return undefined;
      }
      tokens += input + output;
    }
  }
  return { tokens };
}

function parseCostTotals(page: Page): CostTotals | undefined {
  let usd = 0;
  for (const bucket of page.data) {
    const results = bucket.result as readonly RecordValue[];
    for (const result of results) {
      const amount = asRecord(result.amount);
      const value = finiteNonNegative(amount?.value);
      const currency = typeof amount?.currency === "string" ? amount.currency.toLowerCase() : undefined;
      if (value === undefined || currency !== "usd") return undefined;
      usd += value;
    }
  }
  return { usd };
}

function buildEndpointUrl(
  endpoint: string,
  startTime: number,
  endTime: number,
  groupBy: string,
  cursor?: string,
): string {
  const url = new URL(endpoint);
  url.searchParams.set("start_time", String(startTime));
  url.searchParams.set("end_time", String(endTime));
  url.searchParams.set("bucket_width", "1d");
  url.searchParams.set("group_by", groupBy);
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
    provider: "openai",
    accountKind: "api_organization",
    state,
    fetchedAt,
    message,
  };
}

export class OpenAIApiCollector implements Collector {
  readonly id = "openai-admin";
  readonly provider = "openai" as const;
  readonly accountKind = "api_organization" as const;

  private readonly env: NodeJS.ProcessEnv;
  private readonly request: OpenAIAdminRequester;
  private readonly now: () => Date;

  constructor(options: OpenAIApiCollectorOptions = {}) {
    this.env = options.env ?? process.env;
    this.request = options.requestJson ?? ((request) => requestJson(request));
    this.now = options.now ?? (() => new Date());
  }

  async collect(signal: AbortSignal): Promise<CollectorOutcome> {
    const fetchedAt = this.now();
    const adminKey = getAdminKeys(this.env).openai;
    if (!adminKey) {
      return safeFailure(this.id, "not_configured", fetchedAt, "OpenAI Admin API key is not configured.");
    }
    if (signal.aborted) return safeFailure(this.id, "timeout", fetchedAt, "OpenAI Admin collection was cancelled.");

    const startTime = Math.floor(Date.UTC(fetchedAt.getUTCFullYear(), fetchedAt.getUTCMonth(), 1) / 1_000);
    const endTime = Math.floor(fetchedAt.getTime() / 1_000);
    const headers = { Authorization: `Bearer ${adminKey}` };

    const usage = await this.fetchAllPages<UsageTotals>({
      endpoint: USAGE_ENDPOINT,
      groupBy: "model",
      startTime,
      endTime,
      headers,
      signal,
      parse: parseUsageTotals,
      combine: (left, right) => ({ tokens: left.tokens + right.tokens }),
    });
    if (!usage.ok) return safeFailure(this.id, usage.state, fetchedAt, usage.message);

    const costs = await this.fetchAllPages<CostTotals>({
      endpoint: COST_ENDPOINT,
      groupBy: "line_item",
      startTime,
      endTime,
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
          provider: "openai",
          accountKind: "api_organization",
          label: "Month · OpenAI API completions",
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
          provider: "openai",
          accountKind: "api_organization",
          label: "Month · OpenAI API cost",
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
    readonly groupBy: string;
    readonly startTime: number;
    readonly endTime: number;
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
        return { ok: false, state: "timeout", message: "OpenAI Admin collection was cancelled." };
      }
      if (cursor && seenCursors.has(cursor)) {
        return { ok: false, state: "unsupported_response", message: "OpenAI Admin pagination is invalid." };
      }
      if (cursor) seenCursors.add(cursor);

      let response: RequestJsonResult<unknown>;
      try {
        response = await this.request({
          url: buildEndpointUrl(options.endpoint, options.startTime, options.endTime, options.groupBy, cursor),
          allowedHosts: OPENAI_ALLOWED_HOSTS,
          headers: options.headers,
          signal: options.signal,
        });
      } catch {
        return { ok: false, state: "unavailable", message: "OpenAI Admin request failed." };
      }
      if (!response.ok) return response;

      const page = parsePage(response.data);
      if (!page) return { ok: false, state: "unsupported_response", message: "OpenAI Admin response is unsupported." };
      const parsed = options.parse(page);
      if (!parsed) return { ok: false, state: "unsupported_response", message: "OpenAI Admin response is unsupported." };

      total = total === undefined ? parsed : options.combine(total, parsed);
      if (!page.hasMore) return { ok: true, value: total };
      if (!page.nextPage) {
        return { ok: false, state: "unsupported_response", message: "OpenAI Admin pagination is invalid." };
      }
      cursor = page.nextPage;
    }
  }

}
