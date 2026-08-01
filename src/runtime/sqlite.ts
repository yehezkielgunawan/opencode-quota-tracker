export type SqliteRuntime = "bun" | "node";
export type SqliteModuleSpecifier = "bun:sqlite" | "node:sqlite";

export interface SqliteStatement {
  all<T = unknown>(...params: unknown[]): T[];
  get<T = unknown>(...params: unknown[]): T | undefined;
  run(...params: unknown[]): unknown;
}

export interface ReadonlySqliteDatabase {
  all<T = unknown>(sql: string, params?: readonly unknown[]): T[];
  get<T = unknown>(sql: string, params?: readonly unknown[]): T | null;
  close(): void;
}

export type SqliteModuleLoader = (specifier: SqliteModuleSpecifier) => Promise<unknown>;

export interface OpenReadonlySqliteOptions {
  readonly runtime?: SqliteRuntime;
  readonly loadModule?: SqliteModuleLoader;
}

interface BunDatabase {
  query(sql: string): SqliteStatement;
  close(): void;
}

interface NodeDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

function asBunModule(value: unknown): { Database: new (path: string, options: { readonly: boolean }) => BunDatabase } {
  if (!value || typeof value !== "object" || !("Database" in value)) {
    throw new Error("SQLite Bun backend is unavailable.");
  }
  return value as { Database: new (path: string, options: { readonly: boolean }) => BunDatabase };
}

function asNodeModule(value: unknown): {
  DatabaseSync: new (
    path: string,
    options: { readOnly: boolean; enableForeignKeyConstraints: boolean },
  ) => NodeDatabase;
} {
  if (!value || typeof value !== "object" || !("DatabaseSync" in value)) {
    throw new Error("SQLite Node backend is unavailable.");
  }
  return value as {
    DatabaseSync: new (
      path: string,
      options: { readOnly: boolean; enableForeignKeyConstraints: boolean },
    ) => NodeDatabase;
  };
}

function runPragmas(prepare: (sql: string) => SqliteStatement): void {
  for (const sql of ["PRAGMA query_only = ON", "PRAGMA busy_timeout = 5000"]) {
    try {
      prepare(sql).run();
    } catch {
      // Read-only setup remains safe if a host does not support a pragma.
    }
  }
}

function createAdapter(
  database: BunDatabase | NodeDatabase,
  prepare: (sql: string) => SqliteStatement,
): ReadonlySqliteDatabase {
  return {
    all<T = unknown>(sql: string, params: readonly unknown[] = []): T[] {
      return prepare(sql).all<T>(...params);
    },
    get<T = unknown>(sql: string, params: readonly unknown[] = []): T | null {
      return prepare(sql).get<T>(...params) ?? null;
    },
    close(): void {
      database.close();
    },
  };
}

function detectRuntime(): SqliteRuntime {
  return typeof globalThis === "object" && "Bun" in globalThis ? "bun" : "node";
}

async function defaultLoadModule(specifier: SqliteModuleSpecifier): Promise<unknown> {
  return import(specifier);
}

export async function openReadonlySqlite(
  path: string,
  options: OpenReadonlySqliteOptions = {},
): Promise<ReadonlySqliteDatabase> {
  const runtime = options.runtime ?? detectRuntime();
  const specifier: SqliteModuleSpecifier = runtime === "bun" ? "bun:sqlite" : "node:sqlite";
  const module = await (options.loadModule ?? defaultLoadModule)(specifier);

  if (runtime === "bun") {
    const database = new (asBunModule(module).Database)(path, { readonly: true });
    runPragmas((sql) => database.query(sql));
    return createAdapter(database, (sql) => database.query(sql));
  }

  const database = new (asNodeModule(module).DatabaseSync)(path, {
    readOnly: true,
    enableForeignKeyConstraints: true,
  });
  runPragmas((sql) => database.prepare(sql));
  return createAdapter(database, (sql) => database.prepare(sql));
}
