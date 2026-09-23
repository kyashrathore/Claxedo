import { describe, expect, test } from "bun:test"

import type { BrowserAuthDeployment } from "@/platform/auth/browser-auth"
import { startBrowserAuth } from "./browser-auth-startup"

const HOSTED = { apiOrigin: "https://api.example.test", appOrigin: "https://app.example.test" }

const pending = new Promise<boolean | undefined>(() => {})

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
  test("returns before initialization settles, so the shell never waits for auth", async () => {
    // Never settles: the live shape of the failure this exists to prevent — an
    // entry that awaited this held a blank page with an empty `#root` forever.
    const { calls, adapter } = recordingAdapter(() => new Promise<void>(() => {}))

    const result = startBrowserAuth({ issuesSessions: true, declaration: pending, adapter, ...HOSTED })

    // A returned Promise would allow an entrypoint to await a stalled adapter.
    // Checking only `calls` also passed for an async implementation.
    expect(result).toBeUndefined()
    expect(calls).toEqual([{ ...HOSTED, issuesSessions: true }])
  })

  test("tells the adapter a server that issues no sessions has none to offer", async () => {
    // The adapter still starts: `initialize` settles without a request and
    // without a session client for such a deployment, and it is also where the
    // e2e harness's injected principal is read.
    const { calls, adapter } = recordingAdapter()

    startBrowserAuth({ issuesSessions: false, declaration: pending, adapter, ...HOSTED })

    expect(calls).toEqual([{ ...HOSTED, issuesSessions: false }])
  })

  test("a server that declared no posture is not one that issues sessions", async () => {
    const { calls, adapter } = recordingAdapter()

    startBrowserAuth({ issuesSessions: undefined, declaration: pending, adapter, ...HOSTED })

    expect(calls).toEqual([{ ...HOSTED, issuesSessions: false }])
  })

  test("a declaration that lands after the render deadline starts sign-in again", async () => {
    // Read at the deadline as undeclared, the adapter settles as "issues no
    // sessions"; without a second start, the /login the gate then sends the
    // visitor to could never sign in.
    const { calls, adapter } = recordingAdapter()
    let settle!: (issuesSessions: boolean) => void
    const declaration = new Promise<boolean>((resolve) => {
      settle = resolve
    })

    startBrowserAuth({ issuesSessions: undefined, declaration, adapter, ...HOSTED })
    expect(calls).toEqual([{ ...HOSTED, issuesSessions: false }])

    settle(true)
    await declaration
    expect(calls).toEqual([{ ...HOSTED, issuesSessions: false }, { ...HOSTED, issuesSessions: true }])
  })

  test("a late declaration of no sessions leaves the settled adapter alone", async () => {
    const { calls, adapter } = recordingAdapter()
    const declaration = Promise.resolve(false)

    startBrowserAuth({ issuesSessions: undefined, declaration, adapter, ...HOSTED })
    await declaration

    expect(calls).toEqual([{ ...HOSTED, issuesSessions: false }])
  })

  test.each([
    ["the e2e and dev composition", "http://127.0.0.1:3001"],
    ["a loopback self-host over TLS", "https://localhost:3001"],
  ])("starts against a session-issuing server on a loopback origin (%s)", async (_, apiOrigin) => {
    // A self-hosted node runs its embedded issuer on localhost, so the origin
    // says nothing about the posture. The declaration is passed down from the
    // same reading `CloudAuthGate` uses, so the adapter and the gate cannot
    // disagree — the adapter is told, it does not go and find out.
    const { calls, adapter } = recordingAdapter()

    startBrowserAuth({ issuesSessions: true, declaration: pending, adapter, apiOrigin, appOrigin: "http://localhost:4455" })

    expect(calls).toEqual([{ apiOrigin, appOrigin: "http://localhost:4455", issuesSessions: true }])
  })
})
