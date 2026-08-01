import { DatabaseSync } from "node:sqlite";

import type { ReadonlySqliteDatabase } from "../../src/runtime/sqlite.js";

export interface OpenCodeFixtureMessage {
  readonly role?: string;
  readonly providerID?: string;
  readonly modelID?: string;
  readonly time?: { readonly completed?: number };
  readonly tokens?: {
    readonly total?: number;
    readonly input?: number;
    readonly output?: number;
    readonly reasoning?: number;
    readonly cache?: { readonly read?: number; readonly write?: number };
  };
  readonly cost?: number;
}

export function createOpenCodeFixture(messages: readonly OpenCodeFixtureMessage[]): {
  readonly database: ReadonlySqliteDatabase;
  readonly sql: string[];
  close(): void;
} {
  const database = new DatabaseSync(":memory:");
  let closed = false;
  const sql: string[] = [];
  database.exec(
    `CREATE TABLE message (id TEXT PRIMARY KEY, time_created INTEGER, time_updated INTEGER, data TEXT)`,
  );

  const insert = database.prepare(
    "INSERT INTO message (id, time_created, time_updated, data) VALUES (?, ?, ?, ?)",
  );
  messages.forEach((message, index) => {
    const completed =
      typeof message.time?.completed === "number" ? message.time.completed : Date.now();
    insert.run(`msg_${index}`, completed, completed, JSON.stringify(message));
  });

  return {
    database: {
      all<T = unknown>(query: string, params: readonly unknown[] = []): T[] {
        sql.push(query);
        return database.prepare(query).all(...(params as never[])) as T[];
      },
      get<T = unknown>(query: string, params: readonly unknown[] = []): T | null {
        sql.push(query);
        return (database.prepare(query).get(...(params as never[])) as T | undefined) ?? null;
      },
      close(): void {
        if (!closed) {
          closed = true;
          database.close();
        }
      },
    },
    sql,
    close(): void {
      if (!closed) {
        closed = true;
        database.close();
      }
    },
  };
}
