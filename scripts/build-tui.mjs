import { access, mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { transformFileAsync } from "@babel/core"

const sourceUrl = new URL("../src/tui.tsx", import.meta.url)
const outputUrl = new URL("../dist/tui.js", import.meta.url)
const sourcePath = fileURLToPath(sourceUrl)

try {
  await access(sourceUrl)
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    throw new Error("Cannot build TUI: src/tui.tsx does not exist (it is added in Task 10).")
  }
  throw error
}

const result = await transformFileAsync(sourcePath, {
  filename: sourcePath,
  presets: [
    ["@babel/preset-typescript", { allExtensions: true, isTSX: true }],
    [
      "babel-preset-solid",
      { generate: "universal", moduleName: "@opentui/solid" },
    ],
  ],
  sourceFileName: "../src/tui.tsx",
  sourceMaps: true,
})

if (!result?.code || !result.map) {
  throw new Error("Babel did not produce JavaScript and a source map for src/tui.tsx.")
}

await mkdir(new URL("../dist", import.meta.url), { recursive: true })
await writeFile(outputUrl, `${result.code}\n//# sourceMappingURL=tui.js.map\n`)
await writeFile(new URL("../dist/tui.js.map", import.meta.url), JSON.stringify(result.map))
