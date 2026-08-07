import { describe, expect, it, vi } from "vitest"

import type { QuotaReport } from "../../src/domain/quota.js"
import plugin, { createQuotaTuiPlugin } from "../../src/tui.js"

const renderedStates = vi.hoisted(() => [] as Array<{ status: string; report?: QuotaReport }>)
vi.mock("../../src/tui/report-view.js", () => ({
  ReportView: (props: { state: { status: string; report?: QuotaReport } }) => {
    renderedStates.push(props.state)
    return null
  },
}))

const NOW = new Date("2026-07-31T12:00:00.000Z")

function report(): QuotaReport {
  return { generatedAt: NOW, sections: [] }
}

function apiFixture() {
  const registeredLayers: any[] = []
  const layerCleanups: ReturnType<typeof vi.fn>[] = []
  let registeredRoutes: any[] = []
  const unregisterRoutes = vi.fn()
  const popMode = vi.fn()
  const replace = vi.fn()
  const registerLayer = vi.fn((layer: any) => {
    registeredLayers.push(layer)
    const cleanup = vi.fn()
    layerCleanups.push(cleanup)
    return cleanup
  })
  const registerRoutes = vi.fn((routes: any[]) => {
    registeredRoutes = routes
    return unregisterRoutes
  })
  const navigate = vi.fn()
  const pushMode = vi.fn(() => popMode)
  const onDispose = vi.fn((dispose: () => void) => {
    return () => dispose()
  })

  return {
    api: {
      keymap: { registerLayer },
      mode: { push: pushMode },
      route: {
        current: { name: "session", params: { sessionID: "session-1" } },
        register: registerRoutes,
        navigate,
      },
      theme: { current: {} },
      ui: { dialog: { replace, clear: vi.fn() } },
      lifecycle: { onDispose },
    },
    get command() {
      return registeredLayers.flatMap((layer) => layer.commands ?? []).find((value) => value.name === "quota.show")
    },
    get escapeBinding() {
      return registeredLayers
        .find((layer) => layer.mode === "quota")
        ?.bindings?.find((binding: { key: string }) => binding.key === "escape")
    },
    get quotaRoute() {
      return registeredRoutes.find((route) => route.name === "quota")
    },
    get registerLayer() {
      return registerLayer
    },
    get registerRoutes() {
      return registerRoutes
    },
    get navigate() {
      return navigate
    },
    get pushMode() {
      return pushMode
    },
    get popMode() {
      return popMode
    },
    get unregisterRoutes() {
      return unregisterRoutes
    },
    get layerCleanups() {
      return layerCleanups
    },
    get onDispose() {
      return onDispose
    },
    dispose() {
      const cleanup = onDispose.mock.calls[0]?.[0]
      cleanup?.()
    },
  }
}

describe("quota TUI plugin", () => {
  it("exports the target-exclusive TUI module shape OpenCode loads", () => {
    expect(plugin as unknown).toMatchObject({ tui: expect.any(Function) })
  })

  it("registers /quota as a full-screen route and renders it in quota mode", async () => {
    const fixture = apiFixture()
    const generate = vi.fn(async () => report())
    await createQuotaTuiPlugin({ service: { generate }, now: () => NOW })(fixture.api as never, undefined, {} as never)

    expect(fixture.registerLayer).toHaveBeenCalledTimes(2)
    expect(fixture.registerRoutes).toHaveBeenCalledTimes(1)
    expect(fixture.quotaRoute).toMatchObject({ name: "quota", render: expect.any(Function) })
    expect(fixture.command).toBeDefined()
    expect(fixture.command).toMatchObject({
      name: "quota.show",
      title: "Show quota report",
      namespace: "palette",
      desc: expect.any(String),
      slashName: "quota",
    })

    await fixture.command.run({} as never)

    expect(fixture.navigate).toHaveBeenCalledWith("quota")
    expect(generate).toHaveBeenCalledTimes(1)
    fixture.quotaRoute.render({})
    expect(fixture.pushMode).toHaveBeenCalledWith("quota")
  })

  it("refreshes on a second invocation instead of submitting a prompt", async () => {
    const fixture = apiFixture()
    const generate = vi.fn(async () => report())
    await createQuotaTuiPlugin({ service: { generate }, now: () => NOW })(fixture.api as never, undefined, {} as never)

    await fixture.command.run({} as never)
    await fixture.command.run({} as never)

    expect(generate).toHaveBeenCalledTimes(2)
    expect(fixture.navigate).toHaveBeenCalledTimes(2)
  })

  it("does not let an older request replace a newer report", async () => {
    const fixture = apiFixture()
    let resolveFirst!: (value: QuotaReport) => void
    let resolveSecond!: (value: QuotaReport) => void
    const first = new Promise<QuotaReport>((resolve) => (resolveFirst = resolve))
    const second = new Promise<QuotaReport>((resolve) => (resolveSecond = resolve))
    const generate = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    await createQuotaTuiPlugin({ service: { generate }, now: () => NOW })(fixture.api as never, undefined, {} as never)

    const firstRun = fixture.command.run({} as never)
    const secondRun = fixture.command.run({} as never)
    const newerReport = report()
    resolveSecond(newerReport)
    await secondRun

    resolveFirst({ generatedAt: new Date("2026-07-31T11:00:00.000Z"), sections: [] })
    await firstRun
    renderedStates.length = 0
    fixture.quotaRoute.render({})

    expect(renderedStates.at(-1)).toMatchObject({ status: "ready", report: newerReport })
  })

  it("returns to the route that opened quota when Escape is pressed", async () => {
    const fixture = apiFixture()
    const generate = vi.fn(async () => report())
    await createQuotaTuiPlugin({ service: { generate }, now: () => NOW })(fixture.api as never, undefined, {} as never)

    await fixture.command.run({} as never)
    fixture.escapeBinding.cmd()

    expect(fixture.navigate).toHaveBeenLastCalledWith("session", { sessionID: "session-1" })
  })

  it("unregisters the route and both keymap layers when disposed", async () => {
    const fixture = apiFixture()
    const generate = vi.fn(async () => report())
    await createQuotaTuiPlugin({ service: { generate }, now: () => NOW })(fixture.api as never, undefined, {} as never)

    fixture.dispose()

    expect(fixture.onDispose).toHaveBeenCalledTimes(1)
    expect(fixture.unregisterRoutes).toHaveBeenCalledTimes(1)
    expect(fixture.layerCleanups).toHaveLength(2)
    expect(fixture.layerCleanups.every((cleanup) => cleanup.mock.calls.length === 1)).toBe(true)
  })
})
