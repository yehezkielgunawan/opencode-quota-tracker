import type { CollectorOutcome } from "../domain/quota.js"

type SuccessfulOutcome = Extract<CollectorOutcome, { state: "ok" }>

export interface SuccessCacheOptions {
  readonly now: () => number
  readonly freshForMs?: number
}

export class SuccessCache<T extends SuccessfulOutcome = SuccessfulOutcome> {
  readonly #entries = new Map<string, { readonly value: T; readonly storedAt: number }>()
  readonly #inFlight = new Map<string, Promise<T | CollectorOutcome>>()
  readonly #now: () => number
  readonly #freshForMs: number

  constructor(options: SuccessCacheOptions) {
    this.#now = options.now
    this.#freshForMs = options.freshForMs ?? 300_000
  }

  get(key: string, refresh: () => Promise<T | CollectorOutcome>): Promise<T | CollectorOutcome> {
    const entry = this.#entries.get(key)
    if (entry && this.#now() - entry.storedAt < this.#freshForMs) {
      return Promise.resolve(entry.value)
    }

    const running = this.#inFlight.get(key)
    if (running) return running

    const pending = this.#refresh(key, entry?.value, refresh)
    this.#inFlight.set(key, pending)
    void pending.then(
      () => this.#inFlight.delete(key),
      () => this.#inFlight.delete(key),
    )
    return pending
  }

  async #refresh(
    key: string,
    prior: T | undefined,
    refresh: () => Promise<T | CollectorOutcome>,
  ): Promise<T | CollectorOutcome> {
    const outcome = await refresh()
    if (outcome.state === "ok") {
      const value = outcome as T
      this.#entries.set(key, { value, storedAt: this.#now() })
      return value
    }

    if (
      prior &&
      (outcome.state === "unavailable" ||
        outcome.state === "rate_limited" ||
        outcome.state === "timeout")
    ) {
      return {
        ...prior,
        state: "stale",
        message: "Cached quota data is stale.",
        warning: "Refresh failed; showing the last successful result.",
      }
    }

    return outcome
  }
}
