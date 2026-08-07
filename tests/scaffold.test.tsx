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
      engines: { node: string }
      peerDependencies: Record<string, string>
      scripts: { prepack: string; test: string }
    }

    expect(packageJson.engines.node).toBe(">=22.12.0")
    expect(packageJson.scripts.test).toBe("vitest run")
    expect(packageJson.scripts.prepack).toContain("verify-package.mjs")
    for (const dependency of ["@opentui/core", "@opentui/keymap", "@opentui/solid"]) {
      expect(packageJson.peerDependencies[dependency]).toBe(">=0.4.5 <0.6.0")
    }
  })
})
