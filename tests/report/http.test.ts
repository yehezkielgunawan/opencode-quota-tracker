import { afterEach, describe, expect, it, vi } from "vitest"

import { requestJson } from "../../src/report/http.js"

describe("requestJson", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ["http://api.example.com/quota", ["api.example.com"]],
    ["https://evil.example.com/quota", ["api.example.com"]],
  ])("rejects a non-HTTPS or non-allowlisted URL before fetch", async (url, allowedHosts) => {
    const fetch = vi.fn<typeof globalThis.fetch>()

    const result = await requestJson({ url, allowedHosts, fetch })

    expect(result).toEqual({
      ok: false,
      state: "unavailable",
      message: "Request URL is not permitted.",
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("returns parsed JSON for a successful response", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ remaining: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    const result = await requestJson<{ readonly remaining: number }>({
      url: "https://api.example.com/quota",
      allowedHosts: ["api.example.com"],
      fetch,
      parse(value) {
        if (
          typeof value !== "object" ||
          value === null ||
          !("remaining" in value) ||
          typeof value.remaining !== "number"
        ) {
          throw new TypeError("incompatible")
        }
        return { remaining: value.remaining }
      },
    })

    expect(result).toEqual({ ok: true, data: { remaining: 42 } })
  })

  it.each([
    [401, "unauthorized", "Request was not authorized."],
    [403, "unauthorized", "Request was not authorized."],
    [429, "rate_limited", "Request was rate limited."],
    [500, "unavailable", "Request is unavailable."],
  ] as const)("maps HTTP %i without parsing its body", async (status, state, message) => {
    const json = vi.fn().mockRejectedValue(new Error("secret response body"))
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue({
      ok: false,
      status,
      json,
    } as unknown as Response)

    const result = await requestJson({
      url: "https://api.example.com/quota",
      allowedHosts: ["api.example.com"],
      headers: { authorization: "Bearer request-secret" },
      fetch,
    })

    expect(result).toEqual({ ok: false, state, message })
    expect(json).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain("request-secret")
    expect(JSON.stringify(result)).not.toContain("secret response body")
  })

  it.each([
    [() => Promise.reject(new SyntaxError("secret malformed body"))],
    [() => Promise.resolve({ unexpected: "secret payload" })],
  ])("maps malformed or incompatible JSON to unsupported_response", async (json) => {
    const result = await requestJson({
      url: "https://api.example.com/quota",
      allowedHosts: ["api.example.com"],
      headers: { authorization: "Bearer request-secret" },
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue({
        ok: true,
        status: 200,
        json,
      } as Response),
      parse() {
        throw new TypeError("secret incompatible response")
      },
    })

    expect(result).toEqual({
      ok: false,
      state: "unsupported_response",
      message: "Response JSON is unsupported.",
    })
    expect(JSON.stringify(result)).not.toMatch(/secret|Bearer/)
  })

  it("aborts after five seconds and maps the failure to timeout", async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("request-secret", "AbortError"))
        })
      })
    })

    const pending = requestJson({
      url: "https://api.example.com/quota",
      allowedHosts: ["api.example.com"],
      fetch,
    })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    await expect(pending).resolves.toEqual({
      ok: false,
      state: "timeout",
      message: "Request timed out.",
    })
  })

  it("settles at the timeout even when fetch ignores the abort signal", async () => {
    vi.useFakeTimers()
    const pending = requestJson({
      url: "https://api.example.com/quota",
      allowedHosts: ["api.example.com"],
      fetch: vi.fn<typeof globalThis.fetch>(() => new Promise(() => {})),
    })

    let settled = false
    void pending.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(settled).toBe(true)
    await expect(pending).resolves.toMatchObject({ ok: false, state: "timeout" })
  })

  it("bounds response JSON consumption with the same timeout", async () => {
    vi.useFakeTimers()
    const json = vi.fn(() => new Promise<unknown>(() => {}))
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json,
    } as unknown as Response)

    const pending = requestJson({
      url: "https://api.example.com/quota",
      allowedHosts: ["api.example.com"],
      fetch,
    })
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(pending).resolves.toEqual({
      ok: false,
      state: "timeout",
      message: "Request timed out.",
    })
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })

  it("does not fetch when the parent signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort(new Error("parent-secret"))
    const fetch = vi.fn<typeof globalThis.fetch>()

    const result = await requestJson({
      url: "https://api.example.com/quota",
      allowedHosts: ["api.example.com"],
      signal: controller.signal,
      fetch,
    })

    expect(fetch).not.toHaveBeenCalled()
    expect(result).toEqual({
      ok: false,
      state: "unavailable",
      message: "Request is unavailable.",
    })
    expect(JSON.stringify(result)).not.toContain("parent-secret")
  })

  it("aborts a hanging fetch when the parent signal aborts", async () => {
    const parent = new AbortController()
    let requestSignal: AbortSignal | undefined
    let rejectFetch!: (reason: unknown) => void
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => {
      requestSignal = init?.signal ?? undefined
      return new Promise((_resolve, reject) => {
        rejectFetch = reject
      })
    })
    const pending = requestJson({
      url: "https://api.example.com/quota",
      allowedHosts: ["api.example.com"],
      signal: parent.signal,
      fetch,
    })

    parent.abort(new Error("parent-secret"))

    await expect(pending).resolves.toEqual({
      ok: false,
      state: "unavailable",
      message: "Request is unavailable.",
    })
    expect(requestSignal?.aborted).toBe(true)
    rejectFetch(new Error("late-secret"))
    await Promise.resolve()
  })

  it("aborts hanging body parsing when the parent signal aborts", async () => {
    const parent = new AbortController()
    let requestSignal: AbortSignal | undefined
    let rejectBody!: (reason: unknown) => void
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => {
      requestSignal = init?.signal ?? undefined
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise<unknown>((_resolve, reject) => {
            rejectBody = reject
          }),
      } as Response)
    })
    const pending = requestJson({
      url: "https://api.example.com/quota",
      allowedHosts: ["api.example.com"],
      signal: parent.signal,
      fetch,
    })
    await Promise.resolve()
    parent.abort(new Error("parent-secret"))

    await expect(pending).resolves.toEqual({
      ok: false,
      state: "unavailable",
      message: "Request is unavailable.",
    })
    expect(requestSignal?.aborted).toBe(true)
    rejectBody(new Error("late-body-secret"))
    await Promise.resolve()
  })

  it("rejects redirects without leaking request or target details", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error("redirected to https://evil.example/body-secret"))

    const result = await requestJson({
      url: "https://api.example.com/quota",
      allowedHosts: ["api.example.com"],
      headers: { authorization: "Bearer request-secret" },
      fetch,
    })

    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error")
    expect(result).toEqual({
      ok: false,
      state: "unavailable",
      message: "Request is unavailable.",
    })
    expect(JSON.stringify(result)).not.toMatch(/evil\.example|body-secret|request-secret|Bearer/)
  })

  it.each([0, -1, Number.NaN])("rejects invalid timeout %s", async (timeoutMs) => {
    await expect(
      requestJson({
        url: "https://api.example.com/quota",
        allowedHosts: ["api.example.com"],
        timeoutMs,
        fetch: vi.fn<typeof globalThis.fetch>(),
      }),
    ).rejects.toThrow("timeoutMs must be a finite positive number")
  })

  it("maps other network failures to unavailable without exception details", async () => {
    const result = await requestJson({
      url: "https://api.example.com/quota",
      allowedHosts: ["api.example.com"],
      headers: { authorization: "Bearer request-secret" },
      fetch: vi.fn<typeof globalThis.fetch>().mockRejectedValue(
        new Error("request-secret network details"),
      ),
    })

    expect(result).toEqual({
      ok: false,
      state: "unavailable",
      message: "Request is unavailable.",
    })
    expect(JSON.stringify(result)).not.toContain("request-secret")
  })
})
