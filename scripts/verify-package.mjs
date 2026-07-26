import { access, readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

/** @param {URL} rootUrl */
export async function verifyPackageArtifacts(rootUrl) {
  const packageJson = JSON.parse(await readFile(new URL("package.json", rootUrl), "utf8"))
  const tuiExport = packageJson.exports?.["./tui"]

  if (!tuiExport || typeof tuiExport !== "object") {
    throw new Error("Cannot pack: package.json does not define the ./tui export.")
  }

  for (const condition of ["import", "types"]) {
    const target = tuiExport[condition]
    if (typeof target !== "string" || !target.startsWith("./")) {
      throw new Error(`Cannot pack: ./tui ${condition} must be a relative package target.`)
    }

    try {
      await access(new URL(target, rootUrl))
    } catch {
      throw new Error(`Cannot pack: ./tui ${condition} target ${target} does not exist.`)
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await verifyPackageArtifacts(new URL("../", import.meta.url))
}
