import { Plugin } from "@opencode/plugin/tui"
import type { Context, Route } from "@opencode/plugin/tui/context"
import { createSignal, onCleanup } from "solid-js"

import { AnthropicApiCollector } from "./collectors/anthropic-admin.js"
import { AnthropicSubscriptionCollector } from "./collectors/anthropic-subscription.js"
import { OpenAIApiCollector } from "./collectors/openai-admin.js"
import { OpenAISubscriptionCollector } from "./collectors/openai-subscription.js"
import { OpenCodeUsageCollector } from "./collectors/opencode.js"
import type { Collector, QuotaReport } from "./domain/quota.js"
import { SuccessCache } from "./report/cache.js"
import { QuotaReportService } from "./report/service.js"
import { loadOpenCodeAuth } from "./runtime/auth.js"
import { getRuntimePaths } from "./runtime/paths.js"
import { ReportView } from "./tui/report-view.js"

const QUOTA_ROUTE = "quota"
const PLUGIN_ID = "opencode-quota-tracker"

export interface ReportGenerator {
  generate(): Promise<QuotaReport>
}

export interface QuotaTuiPluginOptions {
  readonly service?: ReportGenerator
  readonly now?: () => Date
}

function createDefaultService(now: () => Date, channel: string): QuotaReportService {
  const cache = new SuccessCache({ now: () => now().getTime() })
  const dbPaths = getRuntimePaths({ channel }).opencodeDatabasePaths
  const sourceCollectors: readonly Collector[] = [
    new OpenAISubscriptionCollector({ now, auth: () => loadOpenCodeAuth({ dbPaths, now: now() }) }),
    new OpenAIApiCollector({ now }),
    new AnthropicSubscriptionCollector({ now }),
    new AnthropicApiCollector({ now }),
    new OpenCodeUsageCollector({ now, dbPaths }),
  ]
  const collectors = sourceCollectors.map((collector): Collector => ({
    id: collector.id,
    provider: collector.provider,
    accountKind: collector.accountKind,
    collect: (signal) => cache.get(collector.id, () => collector.collect(signal)),
  }))

  return new QuotaReportService({ collectors, now })
}

function registerQuotaCommand(api: Context, open: () => Promise<void>): void {
  api.keymap.layer(() => ({
    mode: "global",
    priority: 100,
    commands: [
      {
        id: "quota.show",
        title: "Show quota report",
        group: "Plugin",
        palette: true,
        description: "Show provider and local quota usage without submitting a prompt.",
        slash: { name: "quota" },
        run: () => open(),
      },
    ],
  }))
}

export function createQuotaTuiPlugin(options: QuotaTuiPluginOptions = {}): Plugin.Definition {
  const now = options.now ?? (() => new Date())

  return Plugin.define({
    id: PLUGIN_ID,
    setup(api) {
      const service = options.service ?? createDefaultService(now, api.app.channel)
      const [state, setState] = createSignal<Parameters<typeof ReportView>[0]["state"]>({ status: "loading" })
      let disposed = false
      let requestId = 0
      let previousRoute: Route = { ...api.ui.router.current() }
      const isQuotaRoute = (route: Route): boolean =>
        route.type === "plugin" && route.id === PLUGIN_ID && route.name === QUOTA_ROUTE

      const close = (): void => {
        api.ui.router.navigate(previousRoute)
      }

      const unregisterRoute = api.ui.router.register({
        name: QUOTA_ROUTE,
        render: () => {
          const popMode = api.keymap.mode.push(QUOTA_ROUTE)
          onCleanup(popMode)
          return <ReportView state={state()} theme={api.theme} />
        },
      })

      api.keymap.layer(() => ({
        mode: QUOTA_ROUTE,
        priority: 100,
        commands: [{ bind: "escape", run: close, description: "Close quota report" }],
      }))

      const open = async (): Promise<void> => {
        if (disposed) return
        const currentRequest = ++requestId
        const current = api.ui.router.current()
        // V2 exposes a mutable Solid route store; retain its value, not its identity.
        if (!isQuotaRoute(current)) previousRoute = { ...current }
        setState({ status: "loading" })
        api.ui.router.navigate({ type: "plugin", name: QUOTA_ROUTE })

        try {
          const report = await service.generate()
          if (disposed || currentRequest !== requestId) return
          setState({ status: "ready", report, now: now() })
        } catch {
          if (disposed || currentRequest !== requestId) return
          setState({ status: "error", message: "Quota sources could not be read." })
        }
      }

      registerQuotaCommand(api, open)
      return () => {
        disposed = true
        requestId += 1
        if (isQuotaRoute(api.ui.router.current())) close()
        unregisterRoute()
      }
    },
  })
}

export default createQuotaTuiPlugin()
