import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface RuntimePathOptions {
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly channel?: string;
}

export interface RuntimePaths {
  readonly opencodeDataDirs: readonly string[];
  readonly opencodeDatabasePaths: readonly string[];
  readonly opencodeConfigDirs: readonly string[];
  readonly opencodeCacheDirs: readonly string[];
  readonly opencodeStateDirs: readonly string[];
  readonly claudeCredentialsPath: string;
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(Boolean))];
}

function getPathModule(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

function envPath(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

function resolveConfigDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  defaultDir: string,
): string | undefined {
  const configured = envPath(env, "OPENCODE_CONFIG_DIR");
  if (!configured) return undefined;

  const pathModule = getPathModule(platform);
  return pathModule.isAbsolute(configured) ? configured : pathModule.resolve(defaultDir, configured);
}

export function getRuntimePaths(options: RuntimePathOptions = {}): RuntimePaths {
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const pathModule = getPathModule(platform);

  // V2 uses XDG roots on every desktop platform (including macOS and Windows).
  const dataHome = envPath(env, "XDG_DATA_HOME") ?? pathModule.join(home, ".local", "share");
  const configHome = envPath(env, "XDG_CONFIG_HOME") ?? pathModule.join(home, ".config");
  const cacheHome = envPath(env, "XDG_CACHE_HOME") ?? pathModule.join(home, ".cache");
  const stateHome = envPath(env, "XDG_STATE_HOME") ?? pathModule.join(home, ".local", "state");
  const dataDirs = [pathModule.join(dataHome, "opencode")];
  const configDirs = [pathModule.join(configHome, "opencode")];
  const cacheDirs = [pathModule.join(cacheHome, "opencode")];
  const stateDirs = [pathModule.join(stateHome, "opencode")];
  const channel = options.channel ?? "latest";
  const sharedDatabase = ["latest", "beta", "next", "prod"].includes(channel)
    || env.OPENCODE_DISABLE_CHANNEL_DB === "1" || env.OPENCODE_DISABLE_CHANNEL_DB === "true";
  const filename = env.OPENCODE_DB ?? (sharedDatabase ? "opencode.db" : `opencode-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`);
  const databasePath = filename === ":memory:" ? filename : pathModule.resolve(dataDirs[0]!, filename);

  const defaultConfigDir = configDirs[0]!;
  const configuredConfigDir = resolveConfigDir(platform, env, defaultConfigDir);
  if (configuredConfigDir) configDirs.unshift(configuredConfigDir);

  return {
    opencodeDataDirs: unique(dataDirs),
    opencodeDatabasePaths: [databasePath],
    opencodeConfigDirs: unique(configDirs),
    opencodeCacheDirs: unique(cacheDirs),
    opencodeStateDirs: unique(stateDirs),
    claudeCredentialsPath: pathModule.join(home, ".claude", ".credentials.json"),
  };
}
