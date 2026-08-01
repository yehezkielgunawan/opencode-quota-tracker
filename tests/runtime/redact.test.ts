import { describe, expect, it } from "vitest";

import {
  maskAccountId,
  maskEmail,
  redactError,
  redactHeaders,
  redactText,
  redactUrl,
  redactValue,
} from "../../src/runtime/redact.js";

describe("redaction", () => {
  it("redacts bearer headers and known secrets while preserving harmless text", () => {
    const secret = "sk-secret-value";
    expect(redactText(`status=401 Authorization: Bearer ${secret}`, [secret])).toBe(
      "status=401 Authorization: Bearer [REDACTED]",
    );
    expect(redactHeaders({ Authorization: `Bearer ${secret}`, "X-Status": "401" }, [secret])).toEqual({
      Authorization: "[REDACTED]",
      "X-Status": "401",
    });
  });

  it("redacts sensitive URL query values without changing harmless parameters", () => {
    expect(
      redactUrl("https://example.test/usage?model=gpt&api_key=sk-test&access_token=oauth", ["sk-test"]),
    ).toBe("https://example.test/usage?model=gpt&api_key=[REDACTED]&access_token=[REDACTED]");
  });

  it("recursively redacts nested sensitive values and known secrets", () => {
    expect(
      redactValue(
        {
          status: 429,
          request: { headers: { authorization: "Bearer oauth-token" } },
          nested: [{ apiKey: "api-secret", message: "api-secret failed" }],
        },
        ["oauth-token", "api-secret"],
      ),
    ).toEqual({
      status: 429,
      request: { headers: { authorization: "[REDACTED]" } },
      nested: [{ apiKey: "[REDACTED]", message: "[REDACTED] failed" }],
    });
  });

  it("masks emails and provider account identifiers stably", () => {
    expect(maskEmail("person@example.com")).toBe("p***@example.com");
    expect(maskAccountId("account-123456")).toBe("acco***456");
    expect(redactValue({ email: "person@example.com", accountId: "account-123456" })).toEqual({
      email: "p***@example.com",
      accountId: "acco***456",
    });
  });

  it("redacts error messages and nested causes without exposing cause details", () => {
    const cause = new Error("request failed with oauth-secret");
    const error = new Error("provider returned 403", { cause });

    const output = redactError(error, ["oauth-secret"]);

    expect(output).toContain("provider returned 403");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("oauth-secret");
  });
});
