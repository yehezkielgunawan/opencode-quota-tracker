import { describe, expect, it } from "vitest";

import { OpenCodeUsageCollector } from "../../src/collectors/opencode.js";
import { createOpenCodeFixture, type OpenCodeFixtureMessage } from "../fixtures/opencode-schema.js";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const at = (value: string) => Date.parse(value);

function message(overrides: OpenCodeFixtureMessage): OpenCodeFixtureMessage {
  return {
    role: "assistant",
    providerID: "anthropic",
    modelID: "claude-sonnet",
    time: { completed: at("2026-07-26T10:00:00.000Z") },
    tokens: { total: 100, input: 70, output: 25, reasoning: 5 },
    cost: 0.5,
    ...overrides,
  };
}

describe("OpenCodeUsageCollector", () => {
  it("aggregates completed assistant usage by UTC period, provider, and model", async () => {
    const fixture = createOpenCodeFixture([
      message({}),
      message({
        providerID: "openai",
        modelID: "gpt-5",
        time: { completed: at("2026-07-25T23:59:59.999Z") },
        tokens: { total: 50 },
        cost: 0.25,
      }),
      message({
        time: { completed: at("2026-07-01T00:00:00.000Z") },
        tokens: { total: 25 },
        cost: 0.1,
      }),
      message({ role: "user", tokens: { total: 999 }, cost: 99 }),
      message({ time: {}, tokens: { total: 500 }, cost: 5 }),
    ]);

    const collector = new OpenCodeUsageCollector({
      dbPaths: ["memory"],
      pathExists: () => true,
      openDatabase: async () => fixture.database,
      now: () => NOW,
    });

    const result = await collector.collect(new AbortController().signal);

    expect(result.state).toBe("ok");
    if (result.state !== "ok") throw new Error("expected successful local usage result");

    expect(result.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "token_usage",
          label: "Today · anthropic/claude-sonnet",
          used: 100,
          authority: "local_record",
          acquisition: "local_database",
        }),
        expect.objectContaining({
          kind: "cost",
          label: "Today · anthropic/claude-sonnet",
          used: 0.5,
        }),
        expect.objectContaining({
          kind: "token_usage",
          label: "Month · openai/gpt-5",
          used: 50,
        }),
        expect.objectContaining({
          kind: "token_usage",
          label: "Month · anthropic/claude-sonnet",
          used: 125,
        }),
        expect.objectContaining({
          kind: "cost",
          label: "Month · anthropic/claude-sonnet",
          used: 0.6,
        }),
      ]),
    );
    expect(result.metrics).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ used: 999 }), expect.objectContaining({ used: 5 })]),
    );
    fixture.close();
  });

  it("uses UTC boundaries for day and month aggregation", async () => {
    const fixture = createOpenCodeFixture([
      message({ time: { completed: at("2026-07-26T00:00:00.000Z") }, tokens: { total: 10 }, cost: 0.1 }),
      message({ time: { completed: at("2026-07-01T00:00:00.000Z") }, tokens: { total: 20 }, cost: 0.2 }),
      message({ time: { completed: at("2026-06-30T23:59:59.999Z") }, tokens: { total: 40 }, cost: 0.4 }),
    ]);

    const collector = new OpenCodeUsageCollector({
      dbPaths: ["memory"],
      pathExists: () => true,
      openDatabase: async () => fixture.database,
      now: () => NOW,
    });
    const result = await collector.collect(new AbortController().signal);

    expect(result.state).toBe("ok");
    if (result.state !== "ok") throw new Error("expected successful local usage result");
    expect(result.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "token_usage", label: "Today · anthropic/claude-sonnet", used: 10 }),
        expect.objectContaining({ kind: "token_usage", label: "Month · anthropic/claude-sonnet", used: 30 }),
      ]),
    );
    expect(result.metrics).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Month · anthropic/claude-sonnet", used: 70 })]),
    );
    fixture.close();
  });

  it("uses only read queries and returns unavailable when no database exists", async () => {
    const queries: string[] = [];
    const fixture = createOpenCodeFixture([message({})]);
    const result = await new OpenCodeUsageCollector({
      dbPaths: ["missing", "memory"],
      pathExists: (path) => path === "memory",
      openDatabase: async () => ({
        ...fixture.database,
        all: <T>(sql: string, params?: readonly unknown[]) => {
          queries.push(sql);
          return fixture.database.all<T>(sql, params);
        },
      }),
      now: () => NOW,
    }).collect(new AbortController().signal);

    expect(result.state).toBe("ok");
    expect(queries.every((query) => /^\s*SELECT\b/i.test(query))).toBe(true);

    const missing = await new OpenCodeUsageCollector({
      dbPaths: ["missing"],
      pathExists: () => false,
      now: () => NOW,
    }).collect(new AbortController().signal);
    expect(missing).toMatchObject({ state: "unavailable" });
    fixture.close();
  });

  it("returns timeout when cancelled before reading the database", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await new OpenCodeUsageCollector({
      dbPaths: ["memory"],
      pathExists: () => true,
      openDatabase: async () => {
        throw new Error("must not open");
      },
      now: () => NOW,
    }).collect(controller.signal);

    expect(result).toMatchObject({ state: "timeout" });
  });
});
