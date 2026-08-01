import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  OpenAISubscriptionCollector,
  type OpenAISubscriptionRequest,
} from "../../src/collectors/openai-subscription.js";
import type { OpenAIAuthResult } from "../../src/runtime/auth.js";
import type { RequestJsonResult } from "../../src/report/http.js";

const NOW = new Date("2026-07-26T12:00:00.000Z");

async function fixture(): Promise<unknown> {
  return JSON.parse(
    await readFile(resolve(import.meta.dirname, "../fixtures/openai-subscription.json"), "utf8"),
  ) as unknown;
}

function configuredAuth(overrides: Partial<Extract<OpenAIAuthResult, { state: "configured" }>> = {}) {
  return {
    state: "configured" as const,
    source: "codex",
    accessToken: "oauth-token",
    accountId: "account-id",
    ...overrides,
  };
}

function requestResult(data: unknown): RequestJsonResult<unknown> {
  return { ok: true, data };
}

describe("OpenAISubscriptionCollector", () => {
  it("returns not_configured without calling the API when OAuth is absent", async () => {
    let called = false;
    const result = await new OpenAISubscriptionCollector({
      auth: async () => ({
        state: "not_configured",
        message: "OpenAI OAuth authentication is not configured.",
      }),
      requestJson: async () => {
        called = true;
        return requestResult({});
      },
      now: () => NOW,
    }).collect(new AbortController().signal);

    expect(result).toMatchObject({ state: "not_configured", provider: "openai" });
    expect(called).toBe(false);
  });

  it("uses the OpenCode OAuth token on the allowlisted consumer host", async () => {
    const calls: OpenAISubscriptionRequest[] = [];
    const result = await new OpenAISubscriptionCollector({
      auth: async () => configuredAuth(),
      requestJson: async (options) => {
        calls.push(options);
        return requestResult(await fixture());
      },
      now: () => NOW,
    }).collect(new AbortController().signal);

    expect(result.state).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://chatgpt.com/backend-api/wham/usage",
      allowedHosts: ["chatgpt.com"],
      headers: {
        Authorization: "Bearer oauth-token",
        "ChatGPT-Account-Id": "account-id",
      },
    });
    expect(calls[0]?.headers?.Authorization).not.toContain("OPENAI_API_KEY");
  });

  it("normalizes multiple windows from duration metadata and reset fields", async () => {
    const result = await new OpenAISubscriptionCollector({
      auth: async () => configuredAuth(),
      requestJson: async () => requestResult(await fixture()),
      now: () => NOW,
    }).collect(new AbortController().signal);

    expect(result.state).toBe("ok");
    if (result.state !== "ok") throw new Error("expected successful subscription result");

    expect(result.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "allowance_window",
          label: "Primary · 5h window",
          used: 25,
          remaining: 75,
          limit: 100,
          resetsAt: new Date("2026-06-26T12:00:00.000Z"),
          authority: "provider_reported",
          acquisition: "consumer_api",
        }),
        expect.objectContaining({
          kind: "allowance_window",
          label: "Secondary · 7d window",
          used: 40,
          remaining: 60,
          resetsAt: new Date("2026-07-26T13:00:00.000Z"),
        }),
      ]),
    );
  });

  it("clamps provider percentages and accepts a valid window when another is malformed", async () => {
    const result = await new OpenAISubscriptionCollector({
      auth: async () => configuredAuth(),
      requestJson: async () =>
        requestResult({
          rate_limit: {
            primary_window: { used_percent: 140, limit_window_seconds: 60 },
            secondary_window: { used_percent: "invalid", limit_window_seconds: 3600 },
          },
        }),
      now: () => NOW,
    }).collect(new AbortController().signal);

    expect(result.state).toBe("ok");
    if (result.state !== "ok") throw new Error("expected successful subscription result");
    expect(result.metrics).toEqual([
      expect.objectContaining({ label: "Primary · 1m window", used: 100, remaining: 0 }),
    ]);
  });

  it("returns unsupported_response when no window is valid instead of inventing zero usage", async () => {
    const result = await new OpenAISubscriptionCollector({
      auth: async () => configuredAuth(),
      requestJson: async () => requestResult({ rate_limit: { primary_window: {} } }),
      now: () => NOW,
    }).collect(new AbortController().signal);

    expect(result).toMatchObject({ state: "unsupported_response" });
    if (result.state !== "unsupported_response") throw new Error("expected unsupported response");
    expect(result.message).not.toContain("0");
  });

  it("ignores invalid reset timestamps while preserving the allowance metric", async () => {
    const result = await new OpenAISubscriptionCollector({
      auth: async () => configuredAuth(),
      requestJson: async () =>
        requestResult({
          rate_limit: {
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 60,
              reset_at: Number.MAX_VALUE,
            },
          },
        }),
      now: () => NOW,
    }).collect(new AbortController().signal);

    expect(result.state).toBe("ok");
    if (result.state !== "ok") throw new Error("expected successful subscription result");
    expect(result.metrics[0]).toMatchObject({ used: 10, remaining: 90 });
    expect(result.metrics[0]?.resetsAt).toBeUndefined();
  });

  it.each([
    ["unauthorized", "unauthorized"],
    ["rate_limited", "rate_limited"],
  ] as const)("maps HTTP %s responses to %s", async (httpState, collectorState) => {
    const result = await new OpenAISubscriptionCollector({
      auth: async () => configuredAuth(),
      requestJson: async () => ({ ok: false, state: httpState, message: "safe" }),
      now: () => NOW,
    }).collect(new AbortController().signal);

    expect(result.state).toBe(collectorState);
  });

  it("passes the collector cancellation signal to the HTTP boundary", async () => {
    let receivedSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const resultPromise = new OpenAISubscriptionCollector({
      auth: async () => configuredAuth(),
      requestJson: async (options) => {
        receivedSignal = options.signal;
        return requestResult(await fixture());
      },
      now: () => NOW,
    }).collect(controller.signal);

    const result = await resultPromise;
    expect(result.state).toBe("ok");
    expect(receivedSignal).toBe(controller.signal);
  });
});
