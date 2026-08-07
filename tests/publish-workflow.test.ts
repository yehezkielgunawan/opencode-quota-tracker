import { access, readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

const root = new URL("../", import.meta.url)

describe("manual publish workflow", () => {
  it("publishes only an existing release through a manual main-branch dispatch", async () => {
    const workflow = await readFile(new URL(".github/workflows/publish.yml", root), "utf8")

    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).not.toContain("  push:")
    expect(workflow).not.toContain("  release:")
    expect(workflow).not.toContain("release-please-action")
    expect(workflow).not.toContain("create-github-app-token")
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'")
    expect(workflow).toContain("environment: npm")
    expect(workflow).toContain("id-token: write")
    expect(workflow).toContain("ref: refs/tags/${{ env.RELEASE_TAG }}")
    expect(workflow).toContain("fetch-depth: 0")
    expect(workflow).toContain('gh release view "$RELEASE_TAG"')
    expect(workflow).toContain(
      'test "$(gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --json isDraft --jq .isDraft)" = "false"',
    )
    expect(workflow).toContain('test "$actual_sha" = "$tag_sha"')
    expect(workflow).toContain('git merge-base --is-ancestor "$actual_sha" "origin/main"')
    expect(workflow).toContain("const expectedTag = `v${packageJson.version}`")
    expect(workflow).toContain("if (process.env.RELEASE_TAG !== expectedTag) {")
    expect(workflow).toContain("npm publish --access public --provenance")
  })

  it("does not retain Release Please configuration", async () => {
    await expect(access(new URL("release-please-config.json", root))).rejects.toThrow()
    await expect(access(new URL(".release-please-manifest.json", root))).rejects.toThrow()
    await expect(access(new URL("CHANGELOG.md", root))).resolves.toBeUndefined()
  })

  it("documents recovery of the existing unpublished release", async () => {
    const readme = await readFile(new URL("README.md", root), "utf8")

    expect(readme).toContain('gh workflow run publish.yml --ref main -f tag="v0.1.3"')
  })
})
