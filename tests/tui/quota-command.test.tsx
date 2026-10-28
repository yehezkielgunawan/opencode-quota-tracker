import type { Context, Route, KeymapLayer, Page } from "@opencode/plugin/tui/context"
import { createRoot } from "solid-js"
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
const PLUGIN_ID = "opencode-quota-tracker"

function report(): QuotaReport {
  return { generatedAt: NOW, sections: [] }
}

function apiFixture(initial: Route = { type: "session", sessionID: "session-1" }) {
  const layers: KeymapLayer[] = []
  let page: Page
  const current = { ...initial }
  const updateRoute = (route: Route) => {
    const record = current as unknown as Record<string, unknown>
    for (const key of Object.keys(record)) delete record[key]
    Object.assign(record, route)
  }
  const unregister = vi.fn()
  const popMode = vi.fn()
  const navigate = vi.fn((route: Route) => {
    updateRoute(route.type === "plugin" ? { ...route, id: route.id ?? PLUGIN_ID } : route)
  })
  const context = {
    app: { version: "2.2.0", channel: "latest" },
    keymap: {
      layer: vi.fn((factory: () => KeymapLayer) => layers.push(factory())),
      mode: { push: vi.fn(() => popMode) },
    },
    ui: {
      router: {
        current: () => current,
        register: vi.fn((value: Page) => { page = value; return unregister }),
        navigate,
      },
    },
    theme: {},
  }
  return {
    context: context as unknown as Context,
    navigate,
    unregister,
    popMode,
    pushMode: context.keymap.mode.push,
    get command() { return layers.flatMap((layer) => layer.commands ?? []).find((cmd) => cmd.id === "quota.show")! },
    get escape() { return layers.find((layer) => layer.mode === "quota")?.commands?.find((cmd) => cmd.bind === "escape")! },
    get page() { return page! },
    setRoute(route: Route) { updateRoute(route) },
    render() {
      let dispose!: () => void
      createRoot((cleanup) => { dispose = cleanup; page.render({}) })
      return dispose
    },
  }
}

function setup(fixture: ReturnType<typeof apiFixture>, generate = async () => report()) {
  return createQuotaTuiPlugin({ service: { generate }, now: () => NOW }).setup(fixture.context)
}

describe("quota V2 TUI plugin", () => {
  it("exports a stable V2 definition without a V1 entrypoint", () => {
    expect(plugin).toMatchObject({ id: PLUGIN_ID, setup: expect.any(Function) })
    expect(plugin).not.toHaveProperty("tui")
    expect(plugin).not.toHaveProperty("server")
  })

  it("registers the palette and slash command without submitting a prompt", async () => {
    const fixture = apiFixture()
    const generate = vi.fn(async () => report())
    await setup(fixture, generate)
    expect(fixture.command).toMatchObject({
      id: "quota.show", title: "Show quota report", palette: true, slash: { name: "quota" },
    })
    expect(fixture.page.name).toBe("quota")
    await fixture.command.run()
    expect(generate).toHaveBeenCalledTimes(1)
    expect(fixture.navigate).toHaveBeenCalledWith({ type: "plugin", name: "quota" })
    const unmount = fixture.render()
    expect(fixture.pushMode).toHaveBeenCalledWith("quota")
    unmount()
    expect(fixture.popMode).toHaveBeenCalledOnce()
  })

  it("renders loading followed by the ready report", async () => {
    const fixture = apiFixture()
    let resolve!: (value: QuotaReport) => void
    await setup(fixture, () => new Promise((done) => { resolve = done }))
    const pending = fixture.command.run()
    let unmount = fixture.render()
    expect(renderedStates.at(-1)).toMatchObject({ status: "loading" })
    unmount()
    resolve(report())
    await pending
    unmount = fixture.render()
    expect(renderedStates.at(-1)).toMatchObject({ status: "ready", report: report() })
    unmount()
  })

  it("renders a safe error when generation fails", async () => {
    const fixture = apiFixture()
    await setup(fixture, async () => { throw new Error("secret detail") })
    await fixture.command.run()
    const unmount = fixture.render()
    expect(renderedStates.at(-1)).toEqual({ status: "error", message: "Quota sources could not be read." })
    unmount()
  })

  it.each<Route>([{ type: "home" }, { type: "session", sessionID: "session-1" },
    { type: "plugin", id: "other-plugin", name: "dashboard", data: { tab: "usage" } },
  ])("restores the opening route after repeated invocations: %j", async (initial) => {
    const fixture = apiFixture(initial)
    const generate = vi.fn(async () => report())
    await setup(fixture, generate)
    await fixture.command.run()
    await fixture.command.run()
    fixture.escape.run()
    expect(generate).toHaveBeenCalledTimes(2)
    expect(fixture.navigate).toHaveBeenLastCalledWith(initial)
  })

  it("does not confuse another plugin's quota route with its own", async () => {
    const initial: Route = { type: "plugin", id: "other-plugin", name: "quota" }
    const fixture = apiFixture(initial)
    await setup(fixture)
    await fixture.command.run()
    fixture.escape.run()
    expect(fixture.navigate).toHaveBeenLastCalledWith(initial)
  })

  it("does not let an older request replace a newer report", async () => {
    const fixture = apiFixture()
    let first!: (value: QuotaReport) => void
    let second!: (value: QuotaReport) => void
    const generate = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { first = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { second = resolve }))
    await setup(fixture, generate)
    const one = fixture.command.run()
    const two = fixture.command.run()
    const newer = report()
    second(newer)
    await two
    first({ generatedAt: new Date(0), sections: [] })
    await one
    const unmount = fixture.render()
    expect(renderedStates.at(-1)).toMatchObject({ status: "ready", report: newer })
    unmount()
  })

  it("restores its active route and unregisters on disposal, ignoring late results", async () => {
    const fixture = apiFixture()
    let resolve!: (value: QuotaReport) => void
    const cleanup = await setup(fixture, () => new Promise((done) => { resolve = done }))
    const pending = fixture.command.run()
    await cleanup?.()
    expect(fixture.navigate).toHaveBeenLastCalledWith({ type: "session", sessionID: "session-1" })
    expect(fixture.unregister).toHaveBeenCalledOnce()
    resolve(report())
    await pending
    const unmount = fixture.render()
    expect(renderedStates.at(-1)).toMatchObject({ status: "loading" })
    unmount()
    const count = fixture.navigate.mock.calls.length
    await fixture.command.run()
    expect(fixture.navigate).toHaveBeenCalledTimes(count)
  })

  it("does not navigate away from another route during disposal", async () => {
    const fixture = apiFixture()
    const cleanup = await setup(fixture)
    await fixture.command.run()
    fixture.setRoute({ type: "home" })
    const count = fixture.navigate.mock.calls.length
    await cleanup?.()
    expect(fixture.navigate).toHaveBeenCalledTimes(count)
    expect(fixture.unregister).toHaveBeenCalledOnce()
  })
})
