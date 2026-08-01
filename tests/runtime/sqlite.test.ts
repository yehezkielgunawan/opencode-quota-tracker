import { describe, expect, it, vi } from "vitest";

import { openReadonlySqlite, type SqliteModuleLoader } from "../../src/runtime/sqlite.js";

describe("openReadonlySqlite", () => {
  it("selects bun:sqlite and exposes a shared read-only query contract", async () => {
    const query = vi.fn(() => ({ all: vi.fn(() => [{ value: 1 }]), run: vi.fn() }));
    const close = vi.fn();
    const Database = vi.fn(function Database() {
      return { query, close };
    });
    const loadModule: SqliteModuleLoader = vi.fn(async (specifier) => {
      expect(specifier).toBe("bun:sqlite");
      return { Database };
    });

    const database = await openReadonlySqlite("/tmp/opencode.db", {
      runtime: "bun",
      loadModule,
    });

    expect(Database).toHaveBeenCalledWith("/tmp/opencode.db", { readonly: true });
    expect(database.all("SELECT 1", ["value"])).toEqual([{ value: 1 }]);
    expect(query).toHaveBeenCalledWith("SELECT 1");
    database.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("selects node:sqlite and exposes the same read-only query contract", async () => {
    const prepare = vi.fn(() => ({ all: vi.fn(() => [{ value: 2 }]), run: vi.fn() }));
    const close = vi.fn();
    const DatabaseSync = vi.fn(function DatabaseSync() {
      return { prepare, close };
    });
    const loadModule: SqliteModuleLoader = vi.fn(async (specifier) => {
      expect(specifier).toBe("node:sqlite");
      return { DatabaseSync };
    });

    const database = await openReadonlySqlite("/tmp/opencode.db", {
      runtime: "node",
      loadModule,
    });

    expect(DatabaseSync).toHaveBeenCalledWith("/tmp/opencode.db", {
      readOnly: true,
      enableForeignKeyConstraints: true,
    });
    expect(database.all("SELECT 2", ["value"])).toEqual([{ value: 2 }]);
    expect(prepare).toHaveBeenCalledWith("SELECT 2");
    database.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("enables SQLite query-only mode when the backend supports run", async () => {
    const run = vi.fn();
    const prepare = vi.fn(() => ({ all: vi.fn(() => []), run }));
    const loadModule: SqliteModuleLoader = async () => ({
      DatabaseSync: vi.fn(function DatabaseSync() {
        return { prepare, close: vi.fn() };
      }),
    });

    await openReadonlySqlite("/tmp/opencode.db", { runtime: "node", loadModule });

    expect(prepare).toHaveBeenCalledWith("PRAGMA query_only = ON");
    expect(prepare).toHaveBeenCalledWith("PRAGMA busy_timeout = 5000");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not eagerly import bun:sqlite", async () => {
    const source = await import("../../src/runtime/sqlite.js");
    expect(source).toHaveProperty("openReadonlySqlite");
  });
});
