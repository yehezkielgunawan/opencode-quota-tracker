import { describe, expect, it } from "vitest";

import usagePageOne from "../fixtures/anthropic-admin-usage.json";
import costPageOne from "../fixtures/anthropic-admin-cost.json";
import { AnthropicApiCollector, type AnthropicAdminRequest } from "../../src/collectors/anthropic-admin.js";
import type { RequestJsonResult } from "../../src/report/http.js";

const NOW = new Date("2026-07-26T12:34:56.000Z");

function response(data: unknown): RequestJsonResult<unknown> {
  return { ok: true, data };
}

function finalPage(data: unknown): unknown {
  return { ...(data as Record<string, unknown>), has_more: false };
}

describe("AnthropicApiCollector", () => {
  it("requires only ANTHROPIC_ADMIN_API_KEY and ignores ordinary API keys", async () => {
    let called = false;
    const result = await new AnthropicApiCollector({
      env: { ANTHROPIC_API_KEY: "ordinary-key" },
      requestJson: async () => {
        called = true;
        return response({});
      },
      now: () => NOW,
    }).collect(new AbortController().signal);

    expect(result).toMatchObject({ state: "not_configured", accountKind: "api_organization" });
    expect(called).toBe(false);
  });

  it("requests ISO UTC month bounds with required Admin headers and follows cursors", async () => {
    const calls: AnthropicAdminRequest[] = [];
    const requestJson = async (options: AnthropicAdminRequest): Promise<RequestJsonResult<unknown>> => {
      calls.push(options);
      const url = new URL(options.url);
      const isUsage = url.pathname.endsWith("/usage_report/messages");
      const cursor = url.searchParams.get("page");

      if (isUsage && cursor === null) return response(usagePageOne);
      if (isUsage && cursor === "usage-page-2") {
        return response(
          finalPage({
            data: [
              {
                results: [
                  {
                    uncached_input_tokens: 30,
                    cache_creation_input_tokens: 5,
                    cache_read_input_tokens: 2,
                    output_tokens: 20,
                  },
                ],
              },
            ],
          }),
        );
      }
      if (!isUsage && cursor === null) return response(costPageOne);
      if (!isUsage && cursor === "cost-page-2") {
        return response(
          finalPage({
            data: [{ results: [{ amount: "75", currency: "usd", cost_type: "tokens" }] }],
          }),
        );
      }
      throw new Error(`unexpected cursor ${cursor}`);
    };

    const result = await new AnthropicApiCollector({
      env: { ANTHROPIC_ADMIN_API_KEY: "admin-key" },
      requestJson,
      now: () => NOW,
    }).collect(new AbortController().signal);

    expect(result.state).toBe("ok");
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.allowedHosts.includes("api.anthropic.com"))).toBe(true);
    expect(calls.every((call) => call.headers?.["x-api-key"] === "admin-key")).toBe(true);
    expect(calls.every((call) => call.headers?.["anthropic-version"] === "2023-06-01")).toBe(true);

    const firstUrl = new URL(calls[0]!.url);
    expect(firstUrl.searchParams.get("starting_at")).toBe("2026-07-01T00:00:00.000Z");
    expect(firstUrl.searchParams.get("ending_at")).toBe(NOW.toISOString());
    expect(firstUrl.searchParams.get("group_by[]")).toBe("model");

    if (result.state !== "ok") throw new Error("expected successful Admin result");
    expect(result.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "token_usage",
          label: "Month · Anthropic API messages",
          used: 237,
          authority: "authoritative",
          acquisition: "official_api",
        }),
        expect.objectContaining({ kind: "cost", label: "Month · Anthropic API cost", used: 2, unit: "usd" }),
      ]),
    );
  });

  it("maps unsupported individual accounts to unavailable and permission failures to unauthorized", async () => {
    const unavailable = await new AnthropicApiCollector({
      env: { ANTHROPIC_ADMIN_API_KEY: "admin-key" },
      requestJson: async () => ({ ok: false, state: "unavailable", message: "not available" }),
      now: () => NOW,
    }).collect(new AbortController().signal);
    expect(unavailable).toMatchObject({ state: "unavailable" });

    const unauthorized = await new AnthropicApiCollector({
      env: { ANTHROPIC_ADMIN_API_KEY: "admin-key" },
      requestJson: async () => ({ ok: false, state: "unauthorized", message: "not authorized" }),
      now: () => NOW,
    }).collect(new AbortController().signal);
    expect(unauthorized).toMatchObject({ state: "unauthorized" });
  });

  it("rejects malformed usage and non-USD cost data", async () => {
    const malformedUsage = await new AnthropicApiCollector({
      env: { ANTHROPIC_ADMIN_API_KEY: "admin-key" },
      requestJson: async () => response({ data: [{ results: [{ output_tokens: 1 }] }] }),
      now: () => NOW,
    }).collect(new AbortController().signal);
    expect(malformedUsage).toMatchObject({ state: "unsupported_response" });

    const ambiguousCost = await new AnthropicApiCollector({
      env: { ANTHROPIC_ADMIN_API_KEY: "admin-key" },
      requestJson: async (options) => {
        if (new URL(options.url).pathname.endsWith("/usage_report/messages")) {
          return response(finalPage({ data: [{ results: [{ input_tokens: 1, output_tokens: 1 }] }] }));
        }
        return response(finalPage({ data: [{ results: [{ amount: "100", currency: "EUR" }] }] }));
      },
      now: () => NOW,
    }).collect(new AbortController().signal);
    expect(ambiguousCost).toMatchObject({ state: "unsupported_response" });
  });
});
