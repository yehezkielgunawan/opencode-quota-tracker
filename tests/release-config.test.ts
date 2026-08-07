import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

const root = new URL("../", import.meta.url)

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(new URL(path, root), "utf8"))
  } catch {
    return undefined
  }
}

describe("release configuration", () => {
  it("uses the Node release strategy for the root npm package", async () => {
    const config = await readJson("release-please-config.json")

    expect(config).toMatchObject({
      packages: {
        ".": {
          "release-type": "node",
          "package-name": "opencode-quota-tracker",
          "include-v-in-tag": true,
          "changelog-path": "CHANGELOG.md",
        },
      },
    })
  })

  it("seeds Release Please from the package version", async () => {
    const manifest = (await readJson(".release-please-manifest.json")) as Record<string, unknown> | undefined
    const packageJson = (await readJson("package.json")) as { version?: string } | undefined

    expect(manifest?.["."]).toBe(packageJson?.version)
  })

  it("records the release automation baseline in the changelog", async () => {
    const changelog = await readFile(new URL("CHANGELOG.md", root), "utf8").catch(() => "")

    expect(changelog).toContain("## [0.1.3]")
  })

  it("publishes exact release tags and supports explicit recovery", async () => {
    const workflow = await readFile(new URL(".github/workflows/publish.yml", root), "utf8")

    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain("ref: refs/tags/${{ env.RELEASE_TAG }}")
    expect(workflow).toContain('gh release view "$RELEASE_TAG"')
    expect(workflow).toContain("EXPECTED_SHA")
    expect(workflow).toContain("environment: release")
  })
})
