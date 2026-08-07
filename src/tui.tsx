import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup } from "solid-js"

import { AnthropicApiCollector } from "./collectors/anthropic-admin.js"
import { AnthropicSubscriptionCollector } from "./collectors/anthropic-subscription.js"
import { OpenAIApiCollector } from "./collectors/openai-admin.js"
import { OpenAISubscriptionCollector } from "./collectors/openai-subscription.js"
import { OpenCodeUsageCollector } from "./collectors/opencode.js"
import type { Collector, QuotaReport } from "./domain/quota.js"
import { SuccessCache } from "./report/cache.js"
import { QuotaReportService } from "./report/service.js"
import { ReportView } from "./tui/report-view.js"

const QUOTA_ROUTE = "quota"

export interface ReportGenerator {
  generate(): Promise<QuotaReport>
}

export interface QuotaTuiPluginOptions {
  readonly service?: ReportGenerator
  readonly now?: () => Date
}

function createDefaultService(now: () => Date): QuotaReportService {
  const cache = new SuccessCache({ now: () => now().getTime() })
  const sourceCollectors: readonly Collector[] = [
    new OpenAISubscriptionCollector({ now }),
    new OpenAIApiCollector({ now }),
    new AnthropicSubscriptionCollector({ now }),
    new AnthropicApiCollector({ now }),
    new OpenCodeUsageCollector({ now }),
  ]
  const collectors = sourceCollectors.map((collector): Collector => ({
    id: collector.id,
    provider: collector.provider,
    accountKind: collector.accountKind,
    collect: (signal) => cache.get(collector.id, () => collector.collect(signal)),
  }))

  return new QuotaReportService({ collectors, now })
}

function registerQuotaCommand(api: TuiPluginApi, open: () => Promise<void>): () => void {
  return api.keymap.registerLayer({
    priority: 100,
    commands: [
      {
        name: "quota.show",
        title: "Show quota report",
        category: "Plugin",
        namespace: "palette",
        desc: "Show provider and local quota usage without submitting a prompt.",
        slashName: "quota",
        run: () => open(),
      },
    ],
  })
}

export function createQuotaTuiPlugin(options: QuotaTuiPluginOptions = {}): TuiPlugin {
  const now = options.now ?? (() => new Date())

  return async (api) => {
    const service = options.service ?? createDefaultService(now)
    const [state, setState] = createSignal<Parameters<typeof ReportView>[0]["state"]>({ status: "loading" })
    let disposed = false
    let requestId = 0
    let previousRoute: TuiRouteCurrent = api.route.current

    const close = (): void => {
      if ("params" in previousRoute) {
        api.route.navigate(previousRoute.name, previousRoute.params)
        return
      }
      api.route.navigate(previousRoute.name)
    }

    const unregisterRoute = api.route.register([
      {
        name: QUOTA_ROUTE,
        render: () => {
          const popMode = api.mode.push(QUOTA_ROUTE)
          onCleanup(popMode)
          return <ReportView state={state()} theme={api.theme.current} />
        },
      },
    ])

    const unregisterRouteKeys = api.keymap.registerLayer({
      mode: QUOTA_ROUTE,
      priority: 100,
      bindings: [{ key: "escape", cmd: close, desc: "Close quota report" }],
    })

    const open = async (): Promise<void> => {
      if (disposed) return
      const currentRequest = ++requestId
      if (api.route.current.name !== QUOTA_ROUTE) previousRoute = api.route.current
      setState({ status: "loading" })
      api.route.navigate(QUOTA_ROUTE)

      try {
        const report = await service.generate()
        if (disposed || currentRequest !== requestId) return
        setState({ status: "ready", report, now: now() })
      } catch {
        if (disposed || currentRequest !== requestId) return
        setState({ status: "error", message: "Quota sources could not be read." })
      }
    }

    const unregister = registerQuotaCommand(api, open)
    api.lifecycle.onDispose(() => {
      disposed = true
      requestId += 1
      if (api.route.current.name === QUOTA_ROUTE) close()
      unregister()
      unregisterRouteKeys()
      unregisterRoute()
    })
  }
}

const tui: TuiPlugin = createQuotaTuiPlugin()
const plugin: TuiPluginModule = { tui }

export default plugin
