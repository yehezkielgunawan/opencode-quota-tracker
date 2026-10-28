import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

import { QuotaLabel } from "./fixtures/quota-label.js"

describe("TSX test transform", () => {
  it("uses the OpenTUI Solid universal transform", () => {
    expect(QuotaLabel).toBeTypeOf("function")
    expect(QuotaLabel.toString()).toContain("createElement")
  })

  it("requires tests and guards the TUI package export", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      engines: { node: string; opencode: string }
      dependencies: Record<string, string>
      exports: Record<string, unknown>
      peerDependencies: Record<string, string>
      scripts: { prepack: string; test: string }
    }

    expect(packageJson.engines.node).toBe(">=22.12.0")
    expect(packageJson.engines.opencode).toBe(">=2.2.0 <3")
    expect(packageJson.dependencies["@opencode/plugin"]).toBe("2.2.0")
    expect(packageJson.peerDependencies).not.toHaveProperty("@opencode-ai/plugin")
    expect(packageJson.peerDependencies).not.toHaveProperty("@opentui/keymap")
    expect(Object.keys(packageJson.exports)).toEqual(["./tui"])
    expect(packageJson.scripts.test).toBe("vitest run")
    expect(packageJson.scripts.prepack).toContain("verify-package.mjs")
    for (const dependency of ["@opentui/core", "@opentui/solid"]) {
      expect(packageJson.peerDependencies[dependency]).toBe("0.7.0")
    }
  })
})
