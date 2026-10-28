import { DatabaseSync } from "node:sqlite";

import type { ReadonlySqliteDatabase } from "../../src/runtime/sqlite.js";

export interface OpenCodeFixtureMessage {
  readonly type?: string;
  readonly model?: { readonly providerID?: string; readonly id?: string };
  readonly time?: { readonly completed?: number };
  readonly tokens?: {
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
    // OpenCode v2.2.0 packages/core/src/session/sql.ts: type/id live outside data.
    `CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)`,
  );

  const insert = database.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  messages.forEach((message, index) => {
    const completed =
      typeof message.time?.completed === "number" ? message.time.completed : Date.now();
    const { type = "assistant", ...data } = message;
    insert.run(`msg_${index}`, "session-1", type, index, completed, completed, JSON.stringify(data));
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
