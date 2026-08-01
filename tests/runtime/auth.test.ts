import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  getAdminKeys,
  loadClaudeAuth,
  loadOpenCodeAuth,
  resolveOpenAIAuth,
} from "../../src/runtime/auth.js";

function createJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

describe("OpenCode authentication", () => {
  it("prefers OpenAI OAuth entries and extracts safe account metadata", () => {
    const accessToken = createJwt({
      "https://api.openai.com/profile": { email: "person@example.com" },
      "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
    });

    const result = resolveOpenAIAuth({
      openai: { type: "api", key: "ignored" },
      codex: { type: "oauth", access: accessToken, expires: Date.now() + 60_000 },
      chatgpt: { type: "oauth", access: "lower-priority-token" },
    });

    expect(result).toMatchObject({
      state: "configured",
      source: "codex",
      accessToken,
      accountId: "account-123",
      email: "person@example.com",
    });
  });

  it("reports expired OpenAI OAuth as unauthorized without exposing the token", () => {
    const accessToken = createJwt({});
    const result = resolveOpenAIAuth(
      { openai: { type: "oauth", access: accessToken, expires: 1_000 } },
      new Date(2_000),
    );

    expect(result.state).toBe("unauthorized");
    if (result.state === "configured") throw new Error("expected expired credentials");
    expect(result.message).not.toContain(accessToken);
  });

  it("loads OpenCode auth from the first existing candidate", async () => {
    const reads: string[] = [];
    const result = await loadOpenCodeAuth({
      paths: ["/missing/auth.json", "/valid/auth.json"],
      readFile: async (path) => {
        reads.push(path);
        if (path === "/valid/auth.json") {
          return JSON.stringify({ openai: { type: "oauth", access: "token" } });
        }
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    });

    expect(reads).toEqual(["/missing/auth.json", "/valid/auth.json"]);
    expect(result.state).toBe("configured");
  });

  it("returns not_configured for malformed or absent OpenCode auth", async () => {
    const result = await loadOpenCodeAuth({
      paths: ["/invalid/auth.json"],
      readFile: async () => "not json",
    });

    expect(result).toMatchObject({ state: "not_configured" });
    if (result.state === "configured") throw new Error("expected malformed credentials");
    expect(result.message).not.toContain("not json");
  });
});

describe("Claude Code authentication", () => {
  it("prefers the macOS Keychain OAuth credential", async () => {
    const result = await loadClaudeAuth({
      platform: "darwin",
      credentialsPath: "/home/tester/.claude/.credentials.json",
      runCommand: async (file, args) => {
        expect(file).toBe("security");
        expect(args).toEqual(["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
        return { code: 0, stdout: JSON.stringify({ claudeAiOauth: { accessToken: "keychain-token" } }) };
      },
      readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: "file-token" } }),
    });

    expect(result).toMatchObject({ state: "configured", source: "macos-keychain", accessToken: "keychain-token" });
  });

  it("falls back to Claude credentials JSON when Keychain is unavailable", async () => {
    const result = await loadClaudeAuth({
      platform: "darwin",
      credentialsPath: "/home/tester/.claude/.credentials.json",
      runCommand: async () => ({ code: 44, stdout: "", stderr: "not found" }),
      readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: "file-token" } }),
    });

    expect(result).toMatchObject({ state: "configured", source: "credentials-file", accessToken: "file-token" });
  });

  it("returns unauthorized for expired Claude OAuth", async () => {
    const result = await loadClaudeAuth({
      platform: "linux",
      credentialsPath: "/home/tester/.claude/.credentials.json",
      now: new Date(10_000),
      readFile: async () =>
        JSON.stringify({ claudeAiOauth: { accessToken: "expired-token", expiresAt: 9_000 } }),
    });

    expect(result.state).toBe("unauthorized");
    if (result.state === "configured") throw new Error("expected expired credentials");
    expect(result.message).not.toContain("expired-token");
  });

  it("returns not_configured for missing or malformed Claude credentials", async () => {
    const result = await loadClaudeAuth({
      platform: "linux",
      credentialsPath: "/home/tester/.claude/.credentials.json",
      readFile: async () => "{broken",
    });

    expect(result).toMatchObject({ state: "not_configured" });
    if (result.state === "configured") throw new Error("expected malformed credentials");
    expect(result.message).not.toContain("broken");
  });
});

describe("Admin API keys", () => {
  it("reads only the documented environment variables and trims them", () => {
    expect(
      getAdminKeys({
        OPENAI_ADMIN_API_KEY: "  openai-admin  ",
        ANTHROPIC_ADMIN_API_KEY: "anthropic-admin",
        OPENAI_API_KEY: "must-not-be-used",
      }),
    ).toEqual({ openai: "openai-admin", anthropic: "anthropic-admin" });
  });

  it("ignores empty Admin API keys", () => {
    expect(getAdminKeys({ OPENAI_ADMIN_API_KEY: " ", ANTHROPIC_ADMIN_API_KEY: "" })).toEqual({});
  });
});
