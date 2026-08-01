import { execFile } from "node:child_process";
import { readFile as readFileFromDisk } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";

import { getRuntimePaths } from "./paths.js";

const execFileAsync = promisify(execFile);
const OPENAI_AUTH_SOURCES = ["openai", "codex", "chatgpt", "opencode"] as const;
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

type RecordValue = Record<string, unknown>;

export type AuthFailureState = "not_configured" | "unauthorized";

export type OpenAIAuthResult =
  | {
      readonly state: "configured";
      readonly source: string;
      readonly accessToken: string;
      readonly accountId?: string;
      readonly email?: string;
      readonly expiresAt?: number;
    }
  | {
      readonly state: AuthFailureState;
      readonly message: string;
    };

export type ClaudeAuthResult =
  | {
      readonly state: "configured";
      readonly source: "macos-keychain" | "credentials-file";
      readonly accessToken: string;
      readonly expiresAt?: number;
    }
  | {
      readonly state: AuthFailureState;
      readonly message: string;
    };

export interface OpenCodeAuthReadOptions {
  readonly paths?: readonly string[];
  readonly readFile?: (path: string) => Promise<string>;
  readonly now?: Date;
}

export interface ClaudeAuthReadOptions {
  readonly platform?: NodeJS.Platform;
  readonly credentialsPath?: string;
  readonly readFile?: (path: string) => Promise<string>;
  readonly runCommand?: CommandRunner;
  readonly now?: Date;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr?: string;
}

export type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

function asRecord(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function parseJson(raw: string): RecordValue | undefined {
  try {
    return asRecord(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

function readString(record: RecordValue, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(record: RecordValue, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function decodeJwtPayload(token: string): RecordValue | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;

  try {
    const decoded = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    return asRecord(JSON.parse(decoded) as unknown);
  } catch {
    return undefined;
  }
}

function resolveJwtMetadata(token: string): { accountId?: string; email?: string } {
  const payload = decodeJwtPayload(token);
  const auth = asRecord(payload?.["https://api.openai.com/auth"]);
  const profile = asRecord(payload?.["https://api.openai.com/profile"]);

  const accountId =
    readString(payload ?? {}, "chatgpt_account_id") ?? readString(auth ?? {}, "chatgpt_account_id");
  const email = readString(payload ?? {}, "email") ?? readString(profile ?? {}, "email");

  return {
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
  };
}

function isExpired(expiresAt: number | undefined, now: Date): boolean {
  return expiresAt !== undefined && expiresAt <= now.getTime();
}

function openAIEntry(value: unknown): {
  accessToken: string;
  expiresAt?: number;
  accountId?: string;
} | undefined {
  const record = asRecord(value);
  if (!record || record.type !== "oauth") return undefined;

  const accessToken = readString(record, "access");
  if (!accessToken) return undefined;

  return {
    accessToken,
    ...(() => {
      const expiresAt = readNumber(record, ["expires", "expiresAt", "expires_at"]);
      return expiresAt === undefined ? {} : { expiresAt };
    })(),
    ...(() => {
      const accountId = readString(record, "accountId") ?? readString(record, "account_id");
      return accountId === undefined ? {} : { accountId };
    })(),
  };
}

export function resolveOpenAIAuth(auth: unknown, now = new Date()): OpenAIAuthResult {
  const root = asRecord(auth);
  if (!root) return { state: "not_configured", message: "OpenCode authentication is not configured." };

  for (const source of OPENAI_AUTH_SOURCES) {
    const entry = openAIEntry(root[source]);
    if (!entry) continue;
    if (isExpired(entry.expiresAt, now)) {
      return { state: "unauthorized", message: "OpenAI authentication has expired." };
    }

    const metadata = resolveJwtMetadata(entry.accessToken);
    return {
      state: "configured",
      source,
      accessToken: entry.accessToken,
      ...(entry.accountId ?? metadata.accountId
        ? { accountId: entry.accountId ?? metadata.accountId }
        : {}),
      ...(metadata.email ? { email: metadata.email } : {}),
      ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
    };
  }

  return { state: "not_configured", message: "OpenAI OAuth authentication is not configured." };
}

export async function loadOpenCodeAuth(options: OpenCodeAuthReadOptions = {}): Promise<OpenAIAuthResult> {
  const paths = options.paths ?? getRuntimePaths().opencodeDataDirs.map((path) => join(path, "auth.json"));
  const readFile = options.readFile ?? ((path: string) => readFileFromDisk(path, "utf8"));
  let parsed: RecordValue | undefined;

  for (const path of paths) {
    try {
      parsed = parseJson(await readFile(path));
    } catch {
      continue;
    }
    if (parsed) break;
  }

  return resolveOpenAIAuth(parsed, options.now);
}

function extractClaudeOAuth(value: unknown): { accessToken: string; expiresAt?: number } | undefined {
  const root = asRecord(value);
  if (!root) return undefined;

  const candidates = [root, asRecord(root.claudeAiOauth), asRecord(root.oauth)].filter(
    (candidate): candidate is RecordValue => candidate !== undefined,
  );

  for (const candidate of candidates) {
    const accessToken =
      readString(candidate, "accessToken") ?? readString(candidate, "access_token") ?? readString(candidate, "token");
    if (!accessToken) continue;

    return {
      accessToken,
      ...(() => {
        const expiresAt = readNumber(candidate, ["expiresAt", "expires_at", "expires"]);
        return expiresAt === undefined ? {} : { expiresAt };
      })(),
    };
  }

  return undefined;
}

function resolveClaudeCredential(
  raw: string,
  source: "macos-keychain" | "credentials-file",
  now: Date,
): ClaudeAuthResult | undefined {
  const parsed = parseJson(raw);
  const credential = extractClaudeOAuth(parsed);
  if (!credential) return undefined;
  if (isExpired(credential.expiresAt, now)) {
    return { state: "unauthorized", message: "Claude authentication has expired." };
  }

  return { state: "configured", source, ...credential };
}

async function defaultCommandRunner(file: string, args: readonly string[]): Promise<CommandResult> {
  try {
    const result = await execFileAsync(file, [...args], { encoding: "utf8" });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const result = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      code: typeof result.code === "number" ? result.code : 1,
      stdout: result.stdout ?? "",
      ...(result.stderr ? { stderr: result.stderr } : {}),
    };
  }
}

export async function loadClaudeAuth(options: ClaudeAuthReadOptions = {}): Promise<ClaudeAuthResult> {
  const platform = options.platform ?? process.platform;
  const credentialsPath = options.credentialsPath ?? getRuntimePaths({ platform }).claudeCredentialsPath;
  const readFile = options.readFile ?? ((path: string) => readFileFromDisk(path, "utf8"));
  const now = options.now ?? new Date();

  if (platform === "darwin") {
    const runCommand = options.runCommand ?? defaultCommandRunner;
    try {
      const keychain = await runCommand("security", [
        "find-generic-password",
        "-s",
        CLAUDE_KEYCHAIN_SERVICE,
        "-w",
      ]);
      if (keychain.code === 0) {
        const result = resolveClaudeCredential(keychain.stdout, "macos-keychain", now);
        if (result) return result;
      }
    } catch {
      // Fall back to the credentials file without exposing command details.
    }
  }

  try {
    const result = resolveClaudeCredential(await readFile(credentialsPath), "credentials-file", now);
    if (result) return result;
  } catch {
    // Missing or unreadable credentials are represented as not_configured.
  }

  return { state: "not_configured", message: "Claude authentication is not configured." };
}

export function getAdminKeys(env: NodeJS.ProcessEnv = process.env): {
  readonly openai?: string;
  readonly anthropic?: string;
} {
  const openai = env.OPENAI_ADMIN_API_KEY?.trim();
  const anthropic = env.ANTHROPIC_ADMIN_API_KEY?.trim();

  return {
    ...(openai ? { openai } : {}),
    ...(anthropic ? { anthropic } : {}),
  };
}
