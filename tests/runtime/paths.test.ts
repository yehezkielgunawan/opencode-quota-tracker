import { describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/runtime/paths.js";

describe("getRuntimePaths", () => {
  it("uses Linux XDG locations and the Claude credentials fallback", () => {
    const paths = getRuntimePaths({
      platform: "linux",
      homeDir: "/home/tester",
      env: {},
    });

    expect(paths.opencodeDataDirs).toEqual(["/home/tester/.local/share/opencode"]);
    expect(paths.opencodeConfigDirs).toEqual(["/home/tester/.config/opencode"]);
    expect(paths.opencodeCacheDirs).toEqual(["/home/tester/.cache/opencode"]);
    expect(paths.opencodeStateDirs).toEqual(["/home/tester/.local/state/opencode"]);
    expect(paths.claudeCredentialsPath).toBe("/home/tester/.claude/.credentials.json");
  });

  it("honors Linux XDG overrides", () => {
    const paths = getRuntimePaths({
      platform: "linux",
      homeDir: "/home/tester",
      env: {
        XDG_DATA_HOME: "/mnt/data",
        XDG_CONFIG_HOME: "/mnt/config",
        XDG_CACHE_HOME: "/mnt/cache",
        XDG_STATE_HOME: "/mnt/state",
      },
    });

    expect(paths.opencodeDataDirs[0]).toBe("/mnt/data/opencode");
    expect(paths.opencodeConfigDirs[0]).toBe("/mnt/config/opencode");
    expect(paths.opencodeCacheDirs[0]).toBe("/mnt/cache/opencode");
    expect(paths.opencodeStateDirs[0]).toBe("/mnt/state/opencode");
  });

  it("includes canonical and legacy macOS locations in priority order", () => {
    const paths = getRuntimePaths({
      platform: "darwin",
      homeDir: "/Users/tester",
      env: {},
    });

    expect(paths.opencodeDataDirs).toEqual([
      "/Users/tester/Library/Application Support/opencode",
      "/Users/tester/.local/share/opencode",
    ]);
    expect(paths.opencodeConfigDirs).toEqual([
      "/Users/tester/Library/Application Support/opencode",
      "/Users/tester/.config/opencode",
    ]);
    expect(paths.opencodeCacheDirs).toEqual([
      "/Users/tester/Library/Caches/opencode",
      "/Users/tester/.cache/opencode",
    ]);
  });

  it("uses Windows application data locations", () => {
    const paths = getRuntimePaths({
      platform: "win32",
      homeDir: "C:\\Users\\tester",
      env: {
        APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
      },
    });

    expect(paths.opencodeDataDirs).toEqual([
      "C:\\Users\\tester\\AppData\\Local\\opencode",
      "C:\\Users\\tester\\AppData\\Roaming\\opencode",
    ]);
    expect(paths.opencodeConfigDirs).toEqual([
      "C:\\Users\\tester\\AppData\\Roaming\\opencode",
      "C:\\Users\\tester\\AppData\\Local\\opencode",
    ]);
    expect(paths.opencodeCacheDirs).toEqual(["C:\\Users\\tester\\AppData\\Local\\opencode"]);
  });

  it("includes configured OpenCode config directory as the first config candidate", () => {
    const paths = getRuntimePaths({
      platform: "linux",
      homeDir: "/home/tester",
      env: {
        OPENCODE_CONFIG_DIR: "/workspace/opencode-config",
      },
    });

    expect(paths.opencodeConfigDirs[0]).toBe("/workspace/opencode-config");
    expect(paths.opencodeConfigDirs).toContain("/home/tester/.config/opencode");
  });
});
