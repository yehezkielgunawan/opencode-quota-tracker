import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"

import { AnthropicApiCollector } from "./collectors/anthropic-admin.js"
import { AnthropicSubscriptionCollector } from "./collectors/anthropic-subscription.js"
import { OpenAIApiCollector } from "./collectors/openai-admin.js"
import { OpenAISubscriptionCollector } from "./collectors/openai-subscription.js"
import { OpenCodeUsageCollector } from "./collectors/opencode.js"
import type { Collector, QuotaReport } from "./domain/quota.js"
import { SuccessCache } from "./report/cache.js"
import { QuotaReportService } from "./report/service.js"
import { ReportView } from "./tui/report-view.js"

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
        name: "quota",
        title: "Show quota report",
        description: "Show provider and local quota usage without submitting a prompt.",
        slash: { name: "quota" },
        run: () => open(),
      },
    ],
  })
}

export function createQuotaTuiPlugin(options: QuotaTuiPluginOptions = {}): TuiPlugin {
  const now = options.now ?? (() => new Date())

  return async (api) => {
    const service = options.service ?? createDefaultService(now)
    let disposed = false
    let requestId = 0

    const open = async (): Promise<void> => {
      if (disposed) return
      const currentRequest = ++requestId
      api.ui.dialog.replace(() => <ReportView state={{ status: "loading" }} />)

      try {
        const report = await service.generate()
        if (disposed || currentRequest !== requestId) return
        api.ui.dialog.replace(() => <ReportView state={{ status: "ready", report, now: now() }} />)
      } catch {
        if (disposed || currentRequest !== requestId) return
        api.ui.dialog.replace(
          () => <ReportView state={{ status: "error", message: "Quota sources could not be read." }} />,
        )
      }
    }

    const unregister = registerQuotaCommand(api, open)
    api.lifecycle.onDispose(() => {
      disposed = true
      requestId += 1
      unregister()
      api.ui.dialog.clear()
    })
  }
}

export default createQuotaTuiPlugin()
