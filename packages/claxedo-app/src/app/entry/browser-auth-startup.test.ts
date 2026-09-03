import { describe, expect, test } from "bun:test"

import type { BrowserAuthDeployment } from "@/platform/auth/browser-auth"
import { startBrowserAuth } from "./browser-auth-startup"

const HOSTED = { apiOrigin: "https://api.example.test", appOrigin: "https://app.example.test" }

function recordingAdapter(initialize: () => Promise<void> = async () => {}) {
  const calls: BrowserAuthDeployment[] = []
  return {
    calls,
    adapter: {
      initialize: (input: BrowserAuthDeployment) => {
        calls.push(input)
        return initialize()
      },
    },
  }
}

describe("startBrowserAuth", () => {
  test("returns before initialization settles, so the shell never waits for auth", () => {
    // Never settles: the live shape of the failure this exists to prevent — an
    // entry that awaited this held a blank page with an empty `#root` forever.
    const { calls, adapter } = recordingAdapter(() => new Promise<void>(() => {}))

    startBrowserAuth({ authEnabled: true, adapter, ...HOSTED })

    // Observable only because the call already returned: it both started the
    // work and came back while that work was still pending.
    expect(calls).toEqual([{ ...HOSTED, centralTransport: "signed-web" }])
  })

  test("starts nothing when the build has no auth", () => {
    const { calls, adapter } = recordingAdapter()

    startBrowserAuth({ authEnabled: false, adapter, ...HOSTED })

    expect(calls).toEqual([])
  })

  test.each([
    ["the e2e and dev composition", "http://127.0.0.1:3001"],
    ["a loopback self-host over TLS", "https://localhost:3001"],
  ])("reports a loopback central plane to the adapter it starts (%s)", (_, apiOrigin) => {
    // A loopback central authenticates by loopback: it has no accounts, so
    // there is nothing to ask it. Decided from the same
    // `centralTransportForServer` reading `CloudAuthGate` uses to decide
    // whether a signed session is required, so the two cannot disagree — the
    // adapter is told, it does not go and find out.
    const { calls, adapter } = recordingAdapter()

    startBrowserAuth({ authEnabled: true, adapter, apiOrigin, appOrigin: "http://localhost:4455" })

    expect(calls).toEqual([{ apiOrigin, appOrigin: "http://localhost:4455", centralTransport: "loopback" }])
  })
})
