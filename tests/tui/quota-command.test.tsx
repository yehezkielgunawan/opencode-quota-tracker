import { describe, expect, it, vi } from "vitest"

import type { QuotaReport } from "../../src/domain/quota.js"
import { createQuotaTuiPlugin } from "../../src/tui.js"

const NOW = new Date("2026-07-31T12:00:00.000Z")

function report(): QuotaReport {
  return { generatedAt: NOW, sections: [] }
}

function apiFixture() {
  let registeredLayer: any
  let disposed = false
  let dialogCleared = 0
  const replace = vi.fn()
  const registerLayer = vi.fn((layer: any) => {
    registeredLayer = layer
    return vi.fn(() => {
      disposed = true
    })
  })
  const onDispose = vi.fn((dispose: () => void) => {
    return () => {
      dispose()
      disposed = true
    }
  })

  return {
    api: {
      keymap: { registerLayer },
      ui: { dialog: { replace, clear: vi.fn(() => void dialogCleared++) } },
      lifecycle: { onDispose },
    },
    get command() {
      return registeredLayer?.commands?.find((value: { name: string }) => value.name === "quota")
    },
    get replace() {
      return replace
    },
    get registerLayer() {
      return registerLayer
    },
    get onDispose() {
      return onDispose
    },
    get dialogCleared() {
      return dialogCleared
    },
    get disposed() {
      return disposed
    },
    dispose() {
      const cleanup = onDispose.mock.calls[0]?.[0]
      cleanup?.()
    },
  }
}

describe("quota TUI plugin", () => {
  it("registers one deterministic /quota command and opens a local loading dialog", async () => {
    const fixture = apiFixture()
    const generate = vi.fn(async () => report())
    const model = vi.fn()
    await createQuotaTuiPlugin({ service: { generate }, now: () => NOW })(fixture.api as never, undefined, {} as never)

    expect(fixture.registerLayer).toHaveBeenCalledTimes(1)
    expect(fixture.command).toBeDefined()
    expect(fixture.command).toMatchObject({ name: "quota", description: expect.any(String) })

    await fixture.command.run({} as never)

    expect(fixture.replace).toHaveBeenCalledTimes(2)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(model).not.toHaveBeenCalled()
    expect(fixture.replace.mock.calls[0]?.[0]).toBeTypeOf("function")
  })

  it("refreshes on a second invocation instead of submitting a prompt", async () => {
    const fixture = apiFixture()
    const generate = vi.fn(async () => report())
    await createQuotaTuiPlugin({ service: { generate }, now: () => NOW })(fixture.api as never, undefined, {} as never)

    await fixture.command.run({} as never)
    await fixture.command.run({} as never)

    expect(generate).toHaveBeenCalledTimes(2)
    expect(fixture.replace).toHaveBeenCalledTimes(4)
  })

  it("removes the keymap layer and dialog when the plugin is disposed", async () => {
    const fixture = apiFixture()
    const generate = vi.fn(async () => report())
    await createQuotaTuiPlugin({ service: { generate }, now: () => NOW })(fixture.api as never, undefined, {} as never)

    fixture.dispose()

    expect(fixture.onDispose).toHaveBeenCalledTimes(1)
    expect(fixture.dialogCleared).toBe(1)
    expect(fixture.disposed).toBe(true)
  })
})
