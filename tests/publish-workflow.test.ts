import { access, readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

const root = new URL("../", import.meta.url)

describe("automatic releases", () => {
  it("runs verification before publishing on main and uses a GitHub App and npm OIDC", async () => {
    const workflow = await readFile(new URL(".github/workflows/publish.yml", root), "utf8")

    expect(workflow).toMatch(/on:\s*\n\s+push:\s*\n\s+branches:\s*\n\s+- main/)
    expect(workflow).not.toContain("workflow_dispatch:")
    expect(workflow).not.toContain("refs/tags/${{ env.RELEASE_TAG }}")
    expect(workflow).toContain("cancel-in-progress: false")
    expect(workflow).toContain("environment: npm")
    expect(workflow).toContain("id-token: write")
    expect(workflow).toContain("fetch-depth: 0")
    expect(workflow).toContain("actions/create-github-app-token@")
    expect(workflow).toContain("token: ${{ steps.app-token.outputs.token }}")
    expect(workflow).toContain("GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}")
    expect(workflow).toContain("pnpm install --frozen-lockfile")
    expect(workflow.indexOf("pnpm check")).toBeLessThan(workflow.indexOf("pnpm exec semantic-release"))
    expect(workflow).not.toContain("registry-url:")
    expect(workflow).not.toContain("npm publish --access public")
  })

  it("uses existing version tags and prepares the changelog and package before the release commit", async () => {
    const { default: release } = await import("../release.config.mjs")

    expect(release.branches).toEqual(["main"])
    expect(release.tagFormat).toBe("v${version}")
    expect(release.plugins).toEqual([
      "@semantic-release/commit-analyzer",
      "@semantic-release/release-notes-generator",
      "@semantic-release/changelog",
      "@semantic-release/npm",
      ["@semantic-release/git", {
        assets: ["CHANGELOG.md", "package.json"],
        message: "chore(release): ${nextRelease.version} [skip ci] [skip release]",
      }],
      "@semantic-release/github",
    ])
  })

  it("keeps the existing changelog and removes the obsolete release setup", async () => {
    await expect(access(new URL("release-please-config.json", root))).rejects.toThrow()
    await expect(access(new URL(".release-please-manifest.json", root))).rejects.toThrow()
    await expect(access(new URL("CHANGELOG.md", root))).resolves.toBeUndefined()

    const readme = await readFile(new URL("README.md", root), "utf8")
    expect(readme).toContain("Conventional Commit")
    expect(readme).not.toContain("gh workflow run publish.yml")
  })
})
