import type { CollectorState } from "../domain/quota.js"

type HttpFailureState = Extract<
  CollectorState,
  "unauthorized" | "rate_limited" | "timeout" | "unsupported_response" | "unavailable"
>

export type RequestJsonResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly state: HttpFailureState; readonly message: string }

export interface RequestJsonOptions<T> {
  readonly url: string
  readonly allowedHosts: readonly string[]
  readonly headers?: Readonly<Record<string, string>>
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
  readonly parse?: (value: unknown) => T
}

const failureMessages: Readonly<Record<HttpFailureState, string>> = {
  unauthorized: "Request was not authorized.",
  rate_limited: "Request was rate limited.",
  timeout: "Request timed out.",
  unsupported_response: "Response JSON is unsupported.",
  unavailable: "Request is unavailable.",
}

function failure(state: HttpFailureState, message = failureMessages[state]): RequestJsonResult<never> {
  return { ok: false, state, message }
}

export async function requestJson<T = unknown>(
  options: RequestJsonOptions<T>,
): Promise<RequestJsonResult<T>> {
  const timeoutMs = options.timeoutMs ?? 5_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a finite positive number")
  }

  let url: URL
  try {
    url = new URL(options.url)
  } catch {
    return failure("unavailable", "Request URL is not permitted.")
  }

  if (url.protocol !== "https:" || !options.allowedHosts.includes(url.hostname)) {
    return failure("unavailable", "Request URL is not permitted.")
  }

  const controller = new AbortController()
  const timeoutFailure = Symbol("request timeout")
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort()
      reject(timeoutFailure)
    }, timeoutMs)
  })

  try {
    const operation = async (): Promise<RequestJsonResult<T>> => {
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        ...(options.headers ? { headers: options.headers } : {}),
        redirect: "error",
        signal: controller.signal,
      })

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) return failure("unauthorized")
        if (response.status === 429) return failure("rate_limited")
        return failure("unavailable")
      }

      try {
        const value: unknown = await response.json()
        return { ok: true, data: options.parse ? options.parse(value) : (value as T) }
      } catch {
        return failure("unsupported_response")
      }
    }

    return await Promise.race([operation(), deadline])
  } catch (error) {
    if (
      error === timeoutFailure ||
      controller.signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      return failure("timeout")
    }
    return failure("unavailable")
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
