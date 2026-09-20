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

    const result = startBrowserAuth({ issuesSessions: true, adapter, ...HOSTED })

    // A returned Promise would allow an entrypoint to await a stalled adapter.
    // Checking only `calls` also passed for an async implementation.
    expect(result).toBeUndefined()
    expect(calls).toEqual([{ ...HOSTED, issuesSessions: true }])
  })

  test("tells the adapter a server that issues no sessions has none to offer", () => {
    // The adapter still starts: `initialize` settles without a request and
    // without a session client for such a deployment, and it is also where the
    // e2e harness's injected principal is read.
    const { calls, adapter } = recordingAdapter()

    startBrowserAuth({ issuesSessions: false, adapter, ...HOSTED })

    expect(calls).toEqual([{ ...HOSTED, issuesSessions: false }])
  })

  test("a server that declared no posture is not one that issues sessions", () => {
    const { calls, adapter } = recordingAdapter()

    startBrowserAuth({ issuesSessions: undefined, adapter, ...HOSTED })

    expect(calls).toEqual([{ ...HOSTED, issuesSessions: false }])
  })

  test.each([
    ["the e2e and dev composition", "http://127.0.0.1:3001"],
    ["a loopback self-host over TLS", "https://localhost:3001"],
  ])("starts against a session-issuing server on a loopback origin (%s)", (_, apiOrigin) => {
    // A self-hosted node runs its embedded issuer on localhost, so the origin
    // says nothing about the posture. The declaration is passed down from the
    // same reading `CloudAuthGate` uses, so the adapter and the gate cannot
    // disagree — the adapter is told, it does not go and find out.
    const { calls, adapter } = recordingAdapter()

    startBrowserAuth({ issuesSessions: true, adapter, apiOrigin, appOrigin: "http://localhost:4455" })

    expect(calls).toEqual([{ apiOrigin, appOrigin: "http://localhost:4455", issuesSessions: true }])
  })
})
