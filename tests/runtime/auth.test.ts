import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn(async () => { throw new Error("Use injected test credentials") }) }));

import {
  getAdminKeys,
  loadClaudeAuth,
  loadOpenCodeAuth,
  resolveOpenAIAuth,
} from "../../src/runtime/auth.js";
import type { ReadonlySqliteDatabase } from "../../src/runtime/sqlite.js";

function credentialFixture(entries: readonly { value: unknown; active?: number; integration?: string; created?: number }[]) {
  const db = new DatabaseSync(":memory:");
  // OpenCode v2.2.0 packages/core/src/credential/sql.ts.
  db.exec("CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, active INTEGER, time_created INTEGER, time_updated INTEGER)");
  entries.forEach((entry, index) => db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(`cred_${index}`, entry.integration ?? "openai", "OAuth", JSON.stringify(entry.value), entry.active ?? null, entry.created ?? index, 0));
  const queries: string[] = [];
  let closed = false;
  const database: ReadonlySqliteDatabase = {
    all<T>(sql: string, params: readonly unknown[] = []): T[] {
      queries.push(sql);
      return db.prepare(sql).all(...params as never[]) as T[];
    },
    get<T>(sql: string, params: readonly unknown[] = []): T | null {
      queries.push(sql);
      return (db.prepare(sql).get(...params as never[]) as T | undefined) ?? null;
    },
    close() { if (!closed) { closed = true; db.close() } },
  };
  return { database, queries, get closed() { return closed } };
}

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

  it("loads the active V2 SQLite credential and its account metadata using read queries", async () => {
    const fixture = credentialFixture([
      { value: { type: "oauth", access: "selected", expires: 20_000, metadata: { accountID: "account-v2" } }, active: 1 },
      { value: { type: "oauth", access: "newer-unselected", expires: 20_000 }, active: 0, created: 100 },
      { value: { type: "oauth", access: "other-provider" }, integration: "anthropic", active: 1 },
    ]);
    const result = await loadOpenCodeAuth({
      dbPaths: ["/missing/opencode.db", "/valid/opencode.db"],
      pathExists: (path) => path === "/valid/opencode.db",
      openDatabase: async () => fixture.database,
      now: new Date(10_000),
    });
    expect(result).toMatchObject({ state: "configured", source: "openai", accessToken: "selected", accountId: "account-v2" });
    expect(fixture.queries.every((query) => /^\s*SELECT\b/i.test(query))).toBe(true);
    expect(fixture.closed).toBe(true);
  });

  it("selects the newest credential when older V2 rows have no active flag", async () => {
    const fixture = credentialFixture([
      { value: { type: "oauth", access: "old" } }, { value: { type: "oauth", access: "new" } },
    ]);
    expect(await loadOpenCodeAuth({ dbPaths: ["memory"], pathExists: () => true, openDatabase: async () => fixture.database }))
      .toMatchObject({ state: "configured", accessToken: "new" });
  });

  it("returns not_configured for absent SQLite credentials", async () => {
    const result = await loadOpenCodeAuth({ dbPaths: ["missing"], pathExists: () => false });
    expect(result).toMatchObject({ state: "not_configured" });
  });

  it("does not fall back to an inactive OAuth account when an API key is selected", async () => {
    const fixture = credentialFixture([
      { value: { type: "oauth", access: "inactive" }, active: 0 },
      { value: { type: "key", key: "inference-key" }, active: 1 },
    ]);
    expect(await loadOpenCodeAuth({ dbPaths: ["memory"], pathExists: () => true, openDatabase: async () => fixture.database }))
      .toMatchObject({ state: "not_configured" });
  });

  it("reports expired V2 OAuth without exposing the token", async () => {
    const fixture = credentialFixture([{ value: { type: "oauth", access: "secret-expired", expires: 1_000 } }]);
    const result = await loadOpenCodeAuth({ dbPaths: ["memory"], pathExists: () => true,
      openDatabase: async () => fixture.database, now: new Date(2_000),
    });
    expect(result).toMatchObject({ state: "unauthorized" });
    expect(JSON.stringify(result)).not.toContain("secret-expired");
  });

  it.each(["invalid-secret-value", {}, { type: "unknown" }, { type: "oauth", access: "" }])("reports malformed SQLite credentials without leaking them: %j", async (value) => {
    const fixture = credentialFixture([{ value }]);
    const result = await loadOpenCodeAuth({ dbPaths: ["memory"], pathExists: () => true, openDatabase: async () => fixture.database });
    expect(result).toMatchObject({ state: "unsupported_response" });
    expect(JSON.stringify(result)).not.toContain("invalid-secret-value");
    expect(fixture.closed).toBe(true);
  });

  it("reports unreadable storage separately from missing configuration", async () => {
    const result = await loadOpenCodeAuth({ dbPaths: ["locked"], pathExists: () => true,
      openDatabase: async () => { throw new Error("secret file path") },
    });
    expect(result).toMatchObject({ state: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("secret file path");
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
