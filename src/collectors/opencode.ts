import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  createCostMetric,
  createTokenUsageMetric,
  type Collector,
  type CollectorOutcome,
  type QuotaMetric,
} from "../domain/quota.js";
import { getRuntimePaths } from "../runtime/paths.js";
import { openReadonlySqlite, type ReadonlySqliteDatabase } from "../runtime/sqlite.js";

interface StoredMessage {
  readonly role?: unknown;
  readonly providerID?: unknown;
  readonly modelID?: unknown;
  readonly time?: { readonly completed?: unknown };
  readonly tokens?: {
    readonly total?: unknown;
    readonly input?: unknown;
    readonly output?: unknown;
    readonly reasoning?: unknown;
  };
  readonly cost?: unknown;
}

interface MessageRow {
  readonly data?: unknown;
}

export interface OpenCodeUsageCollectorOptions {
  readonly dbPaths?: readonly string[];
  readonly pathExists?: (path: string) => boolean;
  readonly openDatabase?: (path: string) => Promise<ReadonlySqliteDatabase>;
  readonly now?: () => Date;
}

type Bucket = {
  tokens: number;
  cost: number;
};

const LOCAL_PROVIDER = "opencode" as const;

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function parseMessage(value: unknown): StoredMessage | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as StoredMessage)
      : undefined;
  } catch {
    return undefined;
  }
}

function tokenCount(tokens: StoredMessage["tokens"]): number {
  if (!tokens || typeof tokens !== "object") return 0;
  const total = numberValue(tokens.total);
  if (total !== undefined) return total;

  const parts: readonly unknown[] = [tokens.input, tokens.output, tokens.reasoning];
  return parts.reduce<number>((sum, value) => sum + (numberValue(value) ?? 0), 0);
}

function startOfUtcDay(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function startOfUtcMonth(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

function addToBucket(buckets: Map<string, Bucket>, key: string, tokens: number, cost: number): void {
  const bucket = buckets.get(key) ?? { tokens: 0, cost: 0 };
  bucket.tokens += tokens;
  bucket.cost += cost;
  buckets.set(key, bucket);
}

function buildMetrics(
  buckets: Map<string, Bucket>,
  period: "Today" | "Month",
  fetchedAt: Date,
): QuotaMetric[] {
  const metrics: QuotaMetric[] = [];
  const entries = [...buckets.entries()]
    .filter(([key]) => key.startsWith(`${period}\u0000`))
    .sort(([left], [right]) => left.localeCompare(right));

  for (const [key, bucket] of entries) {
    const [, provider, model] = key.split("\u0000");
    const label = `${period} · ${provider}/${model}`;
    const base = {
      provider: LOCAL_PROVIDER,
      accountKind: "local" as const,
      label,
      authority: "local_record" as const,
      acquisition: "local_database" as const,
      fetchedAt,
    };

    if (bucket.tokens > 0) {
      metrics.push(createTokenUsageMetric({ ...base, used: bucket.tokens }));
    }
    if (bucket.cost > 0) {
      metrics.push(createCostMetric({ ...base, used: bucket.cost }));
    }
  }

  return metrics;
}

export class OpenCodeUsageCollector implements Collector {
  readonly id = "opencode-usage";
  readonly provider = LOCAL_PROVIDER;
  readonly accountKind = "local" as const;

  private readonly dbPaths: readonly string[];
  private readonly pathExists: (path: string) => boolean;
  private readonly openDatabase: (path: string) => Promise<ReadonlySqliteDatabase>;
  private readonly now: () => Date;

  constructor(options: OpenCodeUsageCollectorOptions = {}) {
    this.dbPaths =
      options.dbPaths ?? getRuntimePaths().opencodeDataDirs.map((path) => join(path, "opencode.db"));
    this.pathExists = options.pathExists ?? existsSync;
    this.openDatabase = options.openDatabase ?? openReadonlySqlite;
    this.now = options.now ?? (() => new Date());
  }

  async collect(signal: AbortSignal): Promise<CollectorOutcome> {
    const fetchedAt = this.now();
    if (signal.aborted) return this.failure("timeout", fetchedAt, "Local usage collection was cancelled.");

    const dbPath = this.dbPaths.find((path) => {
      try {
        return this.pathExists(path);
      } catch {
        return false;
      }
    });

    if (!dbPath) {
      return this.failure("unavailable", fetchedAt, "OpenCode usage database is unavailable.");
    }

    let database: ReadonlySqliteDatabase | undefined;
    try {
      database = await this.openDatabase(dbPath);
      if (signal.aborted) return this.failure("timeout", fetchedAt, "Local usage collection was cancelled.");

      const nowMs = fetchedAt.getTime();
      const monthStartMs = startOfUtcMonth(fetchedAt);
      const dayStartMs = startOfUtcDay(fetchedAt);
      const rows = database.all<MessageRow>(
        `SELECT data FROM "message"
         WHERE json_extract(data, '$.role') = 'assistant'
           AND json_type(data, '$.time.completed') IN ('integer', 'real')
           AND CAST(json_extract(data, '$.time.completed') AS REAL) >= ?
           AND CAST(json_extract(data, '$.time.completed') AS REAL) < ?
         ORDER BY CAST(json_extract(data, '$.time.completed') AS REAL) ASC`,
        [monthStartMs, nowMs],
      );

      if (signal.aborted) return this.failure("timeout", fetchedAt, "Local usage collection was cancelled.");

      const buckets = new Map<string, Bucket>();
      for (const row of rows) {
        const message = parseMessage(row.data);
        const completed = numberValue(message?.time?.completed);
        if (message?.role !== "assistant" || completed === undefined) continue;

        const provider = stringValue(message.providerID, "unknown-provider");
        const model = stringValue(message.modelID, "unknown-model");
        const tokens = tokenCount(message.tokens);
        const cost = numberValue(message.cost) ?? 0;
        addToBucket(buckets, `Month\u0000${provider}\u0000${model}`, tokens, cost);
        if (completed >= dayStartMs) {
          addToBucket(buckets, `Today\u0000${provider}\u0000${model}`, tokens, cost);
        }
      }

      const metrics = [
        ...buildMetrics(buckets, "Today", fetchedAt),
        ...buildMetrics(buckets, "Month", fetchedAt),
      ];
      return {
        collectorId: this.id,
        provider: this.provider,
        accountKind: this.accountKind,
        state: "ok",
        fetchedAt,
        metrics,
      };
    } catch {
      if (signal.aborted) return this.failure("timeout", fetchedAt, "Local usage collection was cancelled.");
      return this.failure("unavailable", fetchedAt, "OpenCode usage could not be read.");
    } finally {
      database?.close();
    }
  }

  private failure(
    state: "timeout" | "unavailable",
    fetchedAt: Date,
    message: string,
  ): CollectorOutcome {
    return {
      collectorId: this.id,
      provider: this.provider,
      accountKind: this.accountKind,
      state,
      fetchedAt,
      message,
    };
  }
}
