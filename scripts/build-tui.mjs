import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { transformFileAsync } from "@babel/core"

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url))
const outputRoot = fileURLToPath(new URL("../dist", import.meta.url))

/** @param {string} directory */
async function collectTsxFiles(directory) {
  /** @type {string[]} */
  const files = []

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectTsxFiles(path)))
    else if (entry.isFile() && entry.name.endsWith(".tsx")) files.push(path)
  }

  return files
}

/**
 * @param {string} sourceDirectory
 * @param {string} outputDirectory
 */
export async function buildTsxFiles(sourceDirectory, outputDirectory) {
  for (const sourcePath of await collectTsxFiles(sourceDirectory)) {
    const relativePath = relative(sourceDirectory, sourcePath)
    const outputPath = join(outputDirectory, relativePath.replace(/\.tsx$/, ".js"))
    const jsxPath = join(outputDirectory, relativePath.replace(/\.tsx$/, ".jsx"))
    const result = await transformFileAsync(sourcePath, {
      babelrc: false,
      configFile: false,
      filename: sourcePath,
      presets: [
        ["@babel/preset-typescript", { allExtensions: true, isTSX: true }],
        [
          "babel-preset-solid",
          { generate: "universal", moduleName: "@opentui/solid" },
        ],
      ],
      sourceFileName: relative(dirname(outputPath), sourcePath),
      sourceMaps: true,
    })

    if (!result?.code || !result.map) {
      throw new Error(`Babel did not produce JavaScript and a source map for ${relativePath}.`)
    }

    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(
      outputPath,
      `${result.code}\n//# sourceMappingURL=${basename(outputPath)}.map\n`,
    )
    await writeFile(`${outputPath}.map`, JSON.stringify(result.map))
    await rm(jsxPath, { force: true })
    await rm(`${jsxPath}.map`, { force: true })
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await access(join(sourceRoot, "tui.tsx"))
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("Cannot build TUI: src/tui.tsx does not exist (it is added in Task 10).")
    }
    throw error
  }

  await buildTsxFiles(sourceRoot, outputRoot)
}
