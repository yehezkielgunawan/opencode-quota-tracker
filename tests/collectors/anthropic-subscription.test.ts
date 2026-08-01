import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AnthropicSubscriptionCollector,
  type AnthropicSubscriptionRequest,
} from "../../src/collectors/anthropic-subscription.js";
import type { ClaudeAuthResult } from "../../src/runtime/auth.js";
import type { RequestJsonResult } from "../../src/report/http.js";

const NOW = new Date("2026-07-26T12:00:00.000Z");

async function fixture(): Promise<unknown> {
  return JSON.parse(
    await readFile(resolve(import.meta.dirname, "../fixtures/anthropic-subscription.json"), "utf8"),
  ) as unknown;
}

function configuredAuth(): Extract<ClaudeAuthResult, { state: "configured" }> {
  return { state: "configured", source: "macos-keychain", accessToken: "claude-oauth-token" };
}

function response(data: unknown): RequestJsonResult<unknown> {
  return { ok: true, data };
}

describe("AnthropicSubscriptionCollector", () => {
  it("uses Claude Code OAuth and the Anthropic consumer headers", async () => {
    const calls: AnthropicSubscriptionRequest[] = [];
    const result = await new AnthropicSubscriptionCollector({
      auth: async () => configuredAuth(),
      requestJson: async (options) => {
        calls.push(options);
        return response(await fixture());
      },
      now: () => NOW,
    }).collect(new AbortController().signal);

    expect(result.state).toBe("ok");
    expect(calls[0]).toMatchObject({
      url: "https://api.anthropic.com/api/oauth/usage",
      allowedHosts: ["api.anthropic.com"],
      headers: {
        Authorization: "Bearer claude-oauth-token",
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
  });

  it("returns not_configured without querying OpenCode Anthropic auth", async () => {
    let called = false;
    const result = await new AnthropicSubscriptionCollector({
      auth: async () => ({ state: "not_configured", message: "Claude authentication is not configured." }),
      requestJson: async () => {
        called = true;
        return response({});
      },
      now: () => NOW,
    }).collect(new AbortController().signal);

    expect(result).toMatchObject({ state: "not_configured", provider: "anthropic" });
    expect(called).toBe(false);
  });

  it("normalizes fraction and percentage usage without inferring reset periods", async () => {
    const result = await new AnthropicSubscriptionCollector({
      auth: async () => configuredAuth(),
      requestJson: async () => response(await fixture()),
      now: () => NOW,
    }).collect(new AbortController().signal);

    expect(result.state).toBe("ok");
    if (result.state !== "ok") throw new Error("expected successful subscription result");
    expect(result.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Five-hour allowance",
          used: 42,
          remaining: 58,
          resetsAt: new Date("2026-07-26T13:00:00.000Z"),
          authority: "provider_reported",
          acquisition: "consumer_api",
        }),
        expect.objectContaining({
          label: "Seven-day allowance",
          used: 75,
          remaining: 25,
          resetsAt: new Date("2026-07-26T14:20:00.000Z"),
        }),
      ]),
    );
  });

  it("accepts volatile wrapper and remaining-percent response variants", async () => {
    const result = await new AnthropicSubscriptionCollector({
      auth: async () => configuredAuth(),
      requestJson: async () =>
        response({
          usage: {
            fiveHour: { remaining_percent: 80, resetsAt: "2026-07-26T13:30:00Z" },
            sevenDay: { utilization: 0.1, resetsAt: "2026-07-27T12:00:00Z" },
          },
        }),
      now: () => NOW,
    }).collect(new AbortController().signal);

    expect(result.state).toBe("ok");
    if (result.state !== "ok") throw new Error("expected successful subscription result");
    expect(result.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Five-hour allowance", used: 20, remaining: 80 }),
        expect.objectContaining({ label: "Seven-day allowance", used: 10, remaining: 90 }),
      ]),
    );
  });

  it("returns unsupported_response when all windows are null or malformed", async () => {
    const result = await new AnthropicSubscriptionCollector({
      auth: async () => configuredAuth(),
      requestJson: async () => response({ five_hour: null, seven_day: { utilization: "unknown" } }),
      now: () => NOW,
    }).collect(new AbortController().signal);

    expect(result).toMatchObject({ state: "unsupported_response" });
  });

  it.each([
    ["unauthorized", "unauthorized"],
    ["rate_limited", "rate_limited"],
  ] as const)("maps HTTP %s responses to %s", async (httpState, collectorState) => {
    const result = await new AnthropicSubscriptionCollector({
      auth: async () => configuredAuth(),
      requestJson: async () => ({ ok: false, state: httpState, message: "safe" }),
      now: () => NOW,
    }).collect(new AbortController().signal);

    expect(result.state).toBe(collectorState);
  });

  it("does not send expired Claude OAuth to the request boundary", async () => {
    let called = false;
    const result = await new AnthropicSubscriptionCollector({
      auth: async () => ({ state: "unauthorized", message: "Claude authentication has expired." }),
      requestJson: async () => {
        called = true;
        return response(await fixture());
      },
      now: () => NOW,
    }).collect(new AbortController().signal);

    expect(result).toMatchObject({ state: "unauthorized" });
    expect(called).toBe(false);
  });
});
