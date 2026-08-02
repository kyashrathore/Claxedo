import { describe, expect, test } from "bun:test"
import { atlassianIntegration } from "./atlassian.js"
import {
  DEFAULT_INTEGRATION_FETCH_TIMEOUT_MS,
  timeoutFetch,
  type IntegrationFetchOptions,
} from "./fetch-timeout.js"
import { githubIntegration } from "./github.js"
import { linearIntegration } from "./linear.js"
import { notionIntegration } from "./notion.js"

const SITE = { site_url: "https://acme.atlassian.net", email: "dev@acme.test" }

// A provider that accepts the connection and then goes silent must not hold a
// host connect request open: `verify` runs inline on that path.
function silentFetch() {
  const signals: (AbortSignal | undefined | null)[] = []
  return {
    signals,
    fetchImpl: (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        signals.push(init?.signal)
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
      }),
  }
}

describe("integration fetch timeout", () => {
  test("defaults to ten seconds", () => {
    expect(DEFAULT_INTEGRATION_FETCH_TIMEOUT_MS).toBe(10_000)
  })

  test("every key-based impl bounds verify at the injected deadline", async () => {
    const cases: { name: string; verify: (o: IntegrationFetchOptions) => Promise<unknown> }[] = [
      { name: "github", verify: (o) => githubIntegration(o).impl.verify!({}, "s") },
      { name: "notion", verify: (o) => notionIntegration(o).impl.verify!({}, "s") },
      { name: "linear", verify: (o) => linearIntegration(o).impl.verify!({}, "s") },
      { name: "atlassian", verify: (o) => atlassianIntegration(o).impl.verify!(SITE, "s") },
    ]
    for (const { name, verify } of cases) {
      const silent = silentFetch()
      // The impls own their catch, so a timed-out call surfaces as the closed
      // `network` reason rather than a rejection.
      const result = await verify({ fetchImpl: silent.fetchImpl, timeoutMs: 5 })
      expect(result, name).toEqual({ ok: false, reason: "network" })
      expect(silent.signals[0]?.aborted, name).toBe(true)
    }
  })

  test("github repository listing is bounded on every page request", async () => {
    const silent = silentFetch()
    const integration = githubIntegration({ fetchImpl: silent.fetchImpl, timeoutMs: 5 })
    // listRepositories has no catch of its own — a timeout classifies as the
    // closed `unavailable` sentinel the service maps to 502.
    await expect(integration.impl.listRepositories!({}, "s")).rejects.toThrow("github_repositories_unavailable")
    expect(silent.signals[0]?.aborted).toBe(true)
  })

  test("a caller-supplied signal still cancels alongside the deadline", async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const wrapped = timeoutFetch({
      fetchImpl: (_url, init) => {
        seen = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
        })
      },
      timeoutMs: 60_000,
    })
    const pending = wrapped("https://provider.test", { signal: controller.signal })
    controller.abort(new Error("host cancelled"))
    await expect(pending).rejects.toThrow("host cancelled")
    expect(seen?.aborted).toBe(true)
  })
})
