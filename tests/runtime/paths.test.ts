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

  it("uses V2 XDG locations on macOS without stale legacy candidates", () => {
    const paths = getRuntimePaths({
      platform: "darwin",
      homeDir: "/Users/tester",
      env: {},
    });

    expect(paths.opencodeDataDirs).toEqual([
      "/Users/tester/.local/share/opencode",
    ]);
    expect(paths.opencodeConfigDirs).toEqual([
      "/Users/tester/.config/opencode",
    ]);
    expect(paths.opencodeCacheDirs).toEqual([
      "/Users/tester/.cache/opencode",
    ]);
  });

  it("uses V2 home-based XDG locations on Windows, not APPDATA", () => {
    const paths = getRuntimePaths({
      platform: "win32",
      homeDir: "C:\\Users\\tester",
      env: {
        APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
      },
    });

    expect(paths.opencodeDataDirs).toEqual([
      "C:\\Users\\tester\\.local\\share\\opencode",
    ]);
    expect(paths.opencodeConfigDirs).toEqual([
      "C:\\Users\\tester\\.config\\opencode",
    ]);
    expect(paths.opencodeCacheDirs).toEqual(["C:\\Users\\tester\\.cache\\opencode"]);
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

  it.each(["linux", "darwin", "win32"] as const)("honors XDG data overrides without legacy fallbacks on %s", (platform) => {
    const paths = getRuntimePaths({ platform, homeDir: "/home/tester", env: { XDG_DATA_HOME: "/custom" } });
    expect(paths.opencodeDataDirs).toHaveLength(1);
    expect(paths.opencodeDataDirs[0]).toContain("custom");
  });

  it.each([
    [{}, "latest", "/home/tester/.local/share/opencode/opencode.db"],
    [{}, "dev/branch", "/home/tester/.local/share/opencode/opencode-dev-branch.db"],
    [{ OPENCODE_DB: "custom.db" }, "latest", "/home/tester/.local/share/opencode/custom.db"],
    [{ OPENCODE_DB: "/custom/usage.db" }, "latest", "/custom/usage.db"],
    [{ OPENCODE_DISABLE_CHANNEL_DB: "true" }, "dev", "/home/tester/.local/share/opencode/opencode.db"],
    [{ OPENCODE_DB: ":memory:" }, "latest", ":memory:"],
  ])("resolves the V2 database for %j / %s", (env, channel, expected) => {
    expect(getRuntimePaths({ platform: "linux", homeDir: "/home/tester", env, channel }).opencodeDatabasePaths).toEqual([expected]);
  });
});
