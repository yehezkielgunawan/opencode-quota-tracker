import { describe, expect, it } from "vitest";

import usagePageOne from "../fixtures/openai-admin-usage.json";
import costPageOne from "../fixtures/openai-admin-costs.json";
import {
  OpenAIApiCollector,
  type OpenAIAdminRequest,
} from "../../src/collectors/openai-admin.js";
import type { RequestJsonResult } from "../../src/report/http.js";

const NOW = new Date("2026-07-26T12:34:56.000Z");

function response(data: unknown): RequestJsonResult<unknown> {
  return { ok: true, data };
}

function pageWithoutMore(data: unknown): unknown {
  return { ...(data as Record<string, unknown>), has_more: false };
}

describe("OpenAIApiCollector", () => {
  it("requires only OPENAI_ADMIN_API_KEY and ignores ordinary API keys", async () => {
    let called = false;
    const result = await new OpenAIApiCollector({
      env: { OPENAI_API_KEY: "ordinary-key" },
      requestJson: async () => {
        called = true;
        return response({});
      },
      now: () => NOW,
    }).collect(new AbortController().signal);

    expect(result).toMatchObject({ state: "not_configured", accountKind: "api_organization" });
    expect(called).toBe(false);
  });

  it("requests month-to-date UTC ranges with Admin auth and follows usage/cost cursors", async () => {
    const calls: OpenAIAdminRequest[] = [];
    const requestJson = async (options: OpenAIAdminRequest): Promise<RequestJsonResult<unknown>> => {
      calls.push(options);
      const url = new URL(options.url);
      const isUsage = url.pathname.endsWith("/usage/completions");
      const cursor = url.searchParams.get("page");

      if (isUsage && cursor === null) return response(usagePageOne);
      if (isUsage && cursor === "usage-cursor-2") {
        return response(
          pageWithoutMore({
            data: [
              {
                object: "bucket",
                result: [
                  {
                    object: "organization.usage.completions.result",
                    input_tokens: 30,
                    output_tokens: 20,
                    input_cached_tokens: 5,
                    output_reasoning_tokens: 7,
                  },
                ],
              },
            ],
          }),
        );
      }
      if (!isUsage && cursor === null) return response(costPageOne);
      if (!isUsage && cursor === "cost-cursor-2") {
        return response(
          pageWithoutMore({
            data: [
              {
                object: "bucket",
                result: [{ object: "organization.costs.result", amount: { value: 0.75, currency: "USD" } }],
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected cursor ${cursor}`);
    };

    const result = await new OpenAIApiCollector({
      env: { OPENAI_ADMIN_API_KEY: "admin-key" },
      requestJson,
      now: () => NOW,
    }).collect(new AbortController().signal);

    expect(result.state).toBe("ok");
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.allowedHosts.includes("api.openai.com"))).toBe(true);
    expect(calls.every((call) => call.headers?.Authorization === "Bearer admin-key")).toBe(true);

    const firstUrl = new URL(calls[0]!.url);
    expect(firstUrl.searchParams.get("start_time")).toBe(
      String(Math.floor(Date.UTC(2026, 6, 1) / 1_000)),
    );
    expect(firstUrl.searchParams.get("end_time")).toBe(String(Math.floor(NOW.getTime() / 1_000)));
    expect(firstUrl.searchParams.get("group_by")).toBe("model");

    if (result.state !== "ok") throw new Error("expected successful Admin result");
    expect(result.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "token_usage",
          label: "Month · OpenAI API completions",
          used: 200,
          authority: "authoritative",
          acquisition: "official_api",
        }),
        expect.objectContaining({
          kind: "cost",
          label: "Month · OpenAI API cost",
          used: 2,
          unit: "usd",
        }),
      ]),
    );
  });

  it("maps Admin authorization and malformed pages safely", async () => {
    const unauthorized = await new OpenAIApiCollector({
      env: { OPENAI_ADMIN_API_KEY: "admin-key" },
      requestJson: async () => ({ ok: false, state: "unauthorized", message: "Request was not authorized." }),
      now: () => NOW,
    }).collect(new AbortController().signal);
    expect(unauthorized).toMatchObject({ state: "unauthorized" });

    const malformed = await new OpenAIApiCollector({
      env: { OPENAI_ADMIN_API_KEY: "admin-key" },
      requestJson: async () => response({ data: [{ result: [{ input_tokens: 10 }] }] }),
      now: () => NOW,
    }).collect(new AbortController().signal);
    expect(malformed).toMatchObject({ state: "unsupported_response" });
  });

  it("rejects ambiguous cost currency instead of emitting a USD metric", async () => {
    const result = await new OpenAIApiCollector({
      env: { OPENAI_ADMIN_API_KEY: "admin-key" },
      requestJson: async (options) => {
        const path = new URL(options.url).pathname;
        if (path.endsWith("/usage/completions")) {
          return response(pageWithoutMore({ data: [{ result: [{ input_tokens: 1, output_tokens: 1 }] }] }));
        }
        return response(
          pageWithoutMore({ data: [{ result: [{ amount: { value: 4, currency: "eur" } }] }] }),
        );
      },
      now: () => NOW,
    }).collect(new AbortController().signal);

    expect(result).toMatchObject({ state: "unsupported_response" });
  });
});
