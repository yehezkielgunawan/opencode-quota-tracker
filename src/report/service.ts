import type {
  AccountKind,
  Collector,
  CollectorOutcome,
  Provider,
  QuotaReport,
  QuotaSection,
} from "../domain/quota.js"

export interface QuotaReportServiceOptions {
  readonly collectors: readonly Collector[]
  readonly now: () => Date
  readonly timeoutMs?: number
}

const accountOrder: Readonly<Record<AccountKind, number>> = {
  subscription: 0,
  api_organization: 1,
  local: 2,
}

const providerOrder: Readonly<Record<Provider, number>> = {
  openai: 0,
  anthropic: 1,
  opencode: 2,
}

export class QuotaReportService {
  readonly #collectors: readonly Collector[]
  readonly #now: () => Date
  readonly #timeoutMs: number

  constructor(options: QuotaReportServiceOptions) {
    this.#collectors = options.collectors
    this.#now = options.now
    this.#timeoutMs = options.timeoutMs ?? 5_000
  }

  async generate(): Promise<QuotaReport> {
    const pending = this.#collectors.map((collector) => this.#collectBounded(collector))
    const settled = await Promise.allSettled(pending)
    const outcomes = settled.map((result, index) => {
      if (result.status === "fulfilled") return result.value

      const collector = this.#collectors[index]
      if (!collector) throw new Error("Collector result index is invalid")
      return this.#failure(collector, "unavailable", "Collector is unavailable.")
    })

    outcomes.sort(
      (left, right) =>
        accountOrder[left.accountKind] - accountOrder[right.accountKind] ||
        providerOrder[left.provider] - providerOrder[right.provider] ||
        left.collectorId.localeCompare(right.collectorId),
    )

    const sections: QuotaSection[] = []
    for (const outcome of outcomes) {
      const previous = sections.at(-1)
      if (previous?.accountKind === outcome.accountKind && previous.provider === outcome.provider) {
        sections[sections.length - 1] = {
          ...previous,
          outcomes: [...previous.outcomes, outcome],
        }
      } else {
        sections.push({
          provider: outcome.provider,
          accountKind: outcome.accountKind,
          outcomes: [outcome],
        })
      }
    }

    return { generatedAt: this.#now(), sections }
  }

  #collectBounded(collector: Collector): Promise<CollectorOutcome> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        resolve(this.#failure(collector, "timeout", "Collector timed out."))
      }, this.#timeoutMs)

      let collection: Promise<CollectorOutcome>
      try {
        collection = collector.collect()
      } catch (error) {
        clearTimeout(timeout)
        reject(error)
        return
      }

      collection.then(
        (outcome) => {
          clearTimeout(timeout)
          resolve(outcome)
        },
        (error: unknown) => {
          clearTimeout(timeout)
          reject(error)
        },
      )
    })
  }

  #failure(
    collector: Collector,
    state: "timeout" | "unavailable",
    message: string,
  ): CollectorOutcome {
    return {
      collectorId: collector.id,
      provider: collector.provider,
      accountKind: collector.accountKind,
      fetchedAt: this.#now(),
      state,
      message,
    }
  }
}
