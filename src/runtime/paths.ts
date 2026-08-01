import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface RuntimePathOptions {
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface RuntimePaths {
  readonly opencodeDataDirs: readonly string[];
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

  let dataDirs: string[];
  let configDirs: string[];
  let cacheDirs: string[];
  let stateDirs: string[];

  if (platform === "darwin") {
    const dataHome = envPath(env, "XDG_DATA_HOME");
    const configHome = envPath(env, "XDG_CONFIG_HOME");
    const cacheHome = envPath(env, "XDG_CACHE_HOME");
    const stateHome = envPath(env, "XDG_STATE_HOME");

    dataDirs = dataHome
      ? [pathModule.join(dataHome, "opencode"), pathModule.join(home, ".local", "share", "opencode")]
      : [
          pathModule.join(home, "Library", "Application Support", "opencode"),
          pathModule.join(home, ".local", "share", "opencode"),
        ];
    configDirs = configHome
      ? [pathModule.join(configHome, "opencode"), pathModule.join(home, ".config", "opencode")]
      : [
          pathModule.join(home, "Library", "Application Support", "opencode"),
          pathModule.join(home, ".config", "opencode"),
        ];
    cacheDirs = cacheHome
      ? [pathModule.join(cacheHome, "opencode"), pathModule.join(home, ".cache", "opencode")]
      : [
          pathModule.join(home, "Library", "Caches", "opencode"),
          pathModule.join(home, ".cache", "opencode"),
        ];
    stateDirs = stateHome
      ? [pathModule.join(stateHome, "opencode"), pathModule.join(home, ".local", "state", "opencode")]
      : [pathModule.join(home, ".local", "state", "opencode")];
  } else if (platform === "win32") {
    const appData = envPath(env, "APPDATA") ?? pathModule.join(home, "AppData", "Roaming");
    const localAppData = envPath(env, "LOCALAPPDATA") ?? pathModule.join(home, "AppData", "Local");

    dataDirs = [pathModule.join(localAppData, "opencode"), pathModule.join(appData, "opencode")];
    configDirs = [pathModule.join(appData, "opencode"), pathModule.join(localAppData, "opencode")];
    cacheDirs = [pathModule.join(localAppData, "opencode")];
    stateDirs = [pathModule.join(localAppData, "opencode")];
  } else {
    const dataHome = envPath(env, "XDG_DATA_HOME") ?? pathModule.join(home, ".local", "share");
    const configHome = envPath(env, "XDG_CONFIG_HOME") ?? pathModule.join(home, ".config");
    const cacheHome = envPath(env, "XDG_CACHE_HOME") ?? pathModule.join(home, ".cache");
    const stateHome = envPath(env, "XDG_STATE_HOME") ?? pathModule.join(home, ".local", "state");

    dataDirs = [pathModule.join(dataHome, "opencode")];
    configDirs = [pathModule.join(configHome, "opencode")];
    cacheDirs = [pathModule.join(cacheHome, "opencode")];
    stateDirs = [pathModule.join(stateHome, "opencode")];
  }

  const defaultConfigDir = configDirs[0]!;
  const configuredConfigDir = resolveConfigDir(platform, env, defaultConfigDir);
  if (configuredConfigDir) configDirs.unshift(configuredConfigDir);

  return {
    opencodeDataDirs: unique(dataDirs),
    opencodeConfigDirs: unique(configDirs),
    opencodeCacheDirs: unique(cacheDirs),
    opencodeStateDirs: unique(stateDirs),
    claudeCredentialsPath: pathModule.join(home, ".claude", ".credentials.json"),
  };
}
