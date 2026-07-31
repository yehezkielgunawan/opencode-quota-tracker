import type { CollectorOutcome } from "../domain/quota.js"

type SuccessfulOutcome = Extract<CollectorOutcome, { state: "ok" }>

export interface SuccessCacheOptions {
  readonly now: () => number
  readonly freshForMs?: number
}

export class SuccessCache {
  readonly #entries = new Map<
    string,
    { readonly value: SuccessfulOutcome; readonly storedAt: number }
  >()
  readonly #inFlight = new Map<string, Promise<CollectorOutcome>>()
  readonly #now: () => number
  readonly #freshForMs: number

  constructor(options: SuccessCacheOptions) {
    const freshForMs = options.freshForMs ?? 300_000
    if (!Number.isFinite(freshForMs) || freshForMs < 0) {
      throw new TypeError("freshForMs must be a finite non-negative number")
    }

    this.#now = options.now
    this.#freshForMs = freshForMs
  }

  get(key: string, refresh: () => Promise<CollectorOutcome>): Promise<CollectorOutcome> {
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
    prior: SuccessfulOutcome | undefined,
    refresh: () => Promise<CollectorOutcome>,
  ): Promise<CollectorOutcome> {
    const outcome = await refresh()
    if (outcome.state === "ok") {
      this.#entries.set(key, { value: outcome, storedAt: this.#now() })
      return outcome
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
