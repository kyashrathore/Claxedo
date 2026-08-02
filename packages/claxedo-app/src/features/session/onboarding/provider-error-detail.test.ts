import { describe, expect, test } from "bun:test"
import { providerErrorDetail, providerLabel, stripRelayPrefix } from "./provider-error-detail"

const apiError = (data: Record<string, unknown>) => ({ name: "APIError", data })

describe("provider error detail", () => {
  test("a 401 auth body names auth and status and keeps the body verbatim", () => {
    const body = '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'
    const { summary, detail } = providerErrorDetail(
      apiError({ message: "Unauthorized", statusCode: 401, isRetryable: false, responseBody: body }),
      { providerID: "anthropic" },
    )

    expect(summary).toBe("Anthropic rejected the credential (401). Check your API key in Settings, then try again.")
    // The owner must be able to tell an expired key from a gateway flake: the
    // provider's own body is carried through byte-for-byte.
    expect(detail).toContain(body)
    expect(detail).toContain("Unauthorized")
  })

  test("a 5xx upstream failure reads as a provider-side error, not a credential problem", () => {
    const { summary, detail } = providerErrorDetail(
      apiError({ message: "Upstream request failed", statusCode: 502, isRetryable: true }),
      { providerID: "opencode" },
    )

    expect(summary).toBe("OpenCode gateway couldn't be reached (502). Try again in a moment.")
    expect(detail).toBe("Upstream request failed")
  })

  test("a rate limit is distinguishable from an auth rejection", () => {
    const { summary } = providerErrorDetail(
      apiError({ message: "Too Many Requests", statusCode: 429, isRetryable: true }),
      { providerID: "anthropic" },
    )
    expect(summary).toBe("Anthropic is rate limiting this key (429). Wait a moment and try again, or use a different key.")
  })

  test("a bodyless network error names the provider and the failure mode", () => {
    const { summary, detail } = providerErrorDetail(
      { name: "UnknownError", data: { message: "fetch failed" } },
      { providerID: "anthropic" },
    )

    expect(summary).toBe("Couldn't reach Anthropic — the request never got a response. Check your connection and try again.")
    expect(detail).toBe("fetch failed")
  })

  // The banned generic-shrug state: even an error carrying nothing at all must
  // produce copy naming what we know.
  test("an error with nothing reported still yields specific transport copy", () => {
    const { summary, detail } = providerErrorDetail({ name: "UnknownError", data: {} }, { providerID: "anthropic" })
    expect(summary).toBe("Couldn't reach Anthropic — the request never got a response. Check your connection and try again.")
    expect(detail).toBeUndefined()
  })

  test("falls back to a neutral noun when even the provider is unknown, never a shrug", () => {
    const { summary } = providerErrorDetail({ name: "UnknownError", data: {} })
    expect(summary).toBe(
      "Couldn't reach the model provider — the request never got a response. Check your connection and try again.",
    )
    expect(summary).not.toMatch(/something went wrong|no more detail/i)
  })

  test("every status-bearing summary carries a repair instruction", () => {
    for (const status of [400, 401, 402, 403, 404, 408, 413, 429, 500, 502, 503, 504, 418, 599]) {
      const { summary } = providerErrorDetail(apiError({ message: "x", statusCode: status }), {
        providerID: "anthropic",
      })
      expect(summary).toContain(`(${status}).`)
      // "what to do about it" — a second sentence after the diagnosis.
      expect(summary!.split(". ").length).toBeGreaterThan(1)
    }
  })

  test("does not duplicate the body when the message already is the body", () => {
    const body = '{"error":"nope"}'
    const { detail } = providerErrorDetail(apiError({ message: body, statusCode: 400, responseBody: body }))
    expect(detail).toBe(body)
  })
})

describe("relay provider label", () => {
  // The "(Console)" the owner saw is the RELAY's label for its upstream
  // account, injected by the opencode gateway, not a provider of ours.
  test("strips the relay's own 'Error from provider (X):' prefix and keeps the label", () => {
    expect(stripRelayPrefix("Error from provider (Console): Upstream request failed")).toEqual({
      message: "Upstream request failed",
      relayLabel: "Console",
    })
    expect(stripRelayPrefix("Error from provider: boom")).toEqual({ message: "boom", relayLabel: undefined })
    expect(stripRelayPrefix("plain message")).toEqual({ message: "plain message", relayLabel: undefined })
  })

  test("the summary names the provider we dispatched to, never the relay's label", () => {
    const { summary, detail } = providerErrorDetail(
      apiError({
        message: "Error from provider (Console): Upstream request failed",
        statusCode: 502,
        isRetryable: true,
      }),
      { providerID: "anthropic" },
    )

    expect(summary).toBe("Anthropic couldn't be reached (502). Try again in a moment.")
    expect(summary).not.toContain("Console")
    // Nothing is lost: the relay's wording survives in the collapsed detail.
    expect(detail).toBe("Upstream request failed")
  })

  test("falls back to the relay label only when we know no provider id", () => {
    expect(providerLabel({ relayLabel: "Console" })).toBe("Console")
    expect(providerLabel({ providerID: "anthropic", relayLabel: "Console" })).toBe("Anthropic")
    expect(providerLabel({ providerID: "some-custom-provider" })).toBe("some-custom-provider")
    expect(providerLabel({})).toBeUndefined()
  })
})
