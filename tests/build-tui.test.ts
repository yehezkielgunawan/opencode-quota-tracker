import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { buildTsxFiles } from "../scripts/build-tui.mjs"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

describe("buildTsxFiles", () => {
  it("recursively transforms TSX and removes TypeScript JSX artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "quota-build-"))
    temporaryDirectories.push(root)
    const sourceRoot = join(root, "src")
    const outputRoot = join(root, "dist")
    await mkdir(join(sourceRoot, "views"), { recursive: true })
    await mkdir(join(outputRoot, "views"), { recursive: true })
    await writeFile(
      join(sourceRoot, "views", "label.tsx"),
      "export const Label = () => <text>quota</text>\n",
    )
    await writeFile(join(outputRoot, "views", "label.jsx"), "stale")
    await writeFile(join(outputRoot, "views", "label.jsx.map"), "stale")

    await buildTsxFiles(sourceRoot, outputRoot)

    expect(await readFile(join(outputRoot, "views", "label.js"), "utf8")).toContain(
      "createElement",
    )
    await expect(access(join(outputRoot, "views", "label.jsx"))).rejects.toThrow()
    await expect(access(join(outputRoot, "views", "label.jsx.map"))).rejects.toThrow()
  })
})
