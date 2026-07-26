import { transformAsync } from "@babel/core"
import { defineConfig } from "vitest/config"

function opentuiSolidTransform() {
  return {
    name: "opentui-solid-transform",
    enforce: "pre" as const,
    async transform(code: string, id: string) {
      const filename = id.split("?", 1)[0]
      if (!filename?.endsWith(".tsx")) return null

      const result = await transformAsync(code, {
        babelrc: false,
        configFile: false,
        filename,
        presets: [
          ["@babel/preset-typescript", { allExtensions: true, isTSX: true }],
          [
            "babel-preset-solid",
            { generate: "universal", moduleName: "@opentui/solid" },
          ],
        ],
        sourceMaps: true,
      })

      if (!result?.code) throw new Error(`Babel did not transform ${filename}.`)
      return { code: result.code, map: result.map ?? null }
    },
  }
}

export default defineConfig({
  plugins: [opentuiSolidTransform()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
})
