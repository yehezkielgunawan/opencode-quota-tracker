import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { verifyPackageArtifacts } from "../scripts/verify-package.mjs"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

describe("verifyPackageArtifacts", () => {
  it("rejects a package whose TUI export target is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "quota-package-"))
    temporaryDirectories.push(root)
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        exports: {
          "./tui": { import: "./dist/tui.js", types: "./dist/tui.d.ts" },
        },
      }),
    )

    await expect(verifyPackageArtifacts(pathToFileURL(`${root}/`))).rejects.toThrow(
      "./dist/tui.js",
    )
  })

  it("accepts a package whose TUI JavaScript and type targets exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "quota-package-"))
    temporaryDirectories.push(root)
    await mkdir(join(root, "dist"))
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        exports: {
          "./tui": { import: "./dist/tui.js", types: "./dist/tui.d.ts" },
        },
      }),
    )
    await writeFile(join(root, "dist", "tui.js"), "export default {}\n")
    await writeFile(join(root, "dist", "tui.d.ts"), "declare const plugin: object\n")

    await expect(verifyPackageArtifacts(pathToFileURL(`${root}/`))).resolves.toBeUndefined()
  })
})
