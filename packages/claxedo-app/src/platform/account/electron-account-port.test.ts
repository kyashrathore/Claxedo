import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { accountBridge, electronAccountPort, type AccountBridge } from "./electron-account-port"

/**
 * The desktop port, against a fake bridge.
 *
 * Two things are worth holding here. The first frame must not claim the user is
 * signed out — on desktop, main answers asynchronously, and an `unsigned` first
 * state flashes a login prompt at a signed user on every launch. The second is
 * that the bridge detection is all-or-nothing: a preload that changed under a
 * renderer that did not should fail at startup, not the first time someone
 * clicks sign out.
 */

function bridge(overrides: Partial<AccountBridge> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const api: AccountBridge = {
    state: async () => {
      calls.push({ method: "state", args: [] })
      return { status: "signed", identity: { userId: "user_1", email: "a@b.test" } }
    },
    signIn: async () => {
      calls.push({ method: "signIn", args: [] })
      return { status: "signed", identity: { userId: "user_1" } }
    },
    signOut: async () => {
      calls.push({ method: "signOut", args: [] })
      return { status: "unsigned" }
    },
    run: async (operation, input) => {
      calls.push({ method: "run", args: [operation, input] })
      return { ran: operation }
    },
    ...overrides,
  }
  return { api, calls }
}

/** Solid signals need an owner; `createRoot` gives one without a component. */
function inRoot<T>(fn: () => T): T {
  return createRoot((dispose) => {
    const value = fn()
    dispose()
    return value
  })
}

describe("electronAccountPort", () => {
  test("reports pending before main answers, not unsigned", () => {
    const port = inRoot(() => electronAccountPort(bridge().api))

    expect(port.state()).toEqual({ status: "pending" })
  })

  test("adopts the state main reports", async () => {
    const port = inRoot(() => electronAccountPort(bridge().api))

    await port.refresh()

    expect(port.state()).toMatchObject({ status: "signed", identity: { email: "a@b.test" } })
  })

  test("updates after sign out rather than keeping a stale identity", async () => {
    // Main owns the state. A port that only read it once would keep showing a
    // signed-in email after the credential was cleared.
    const port = inRoot(() => electronAccountPort(bridge().api))
    await port.refresh()

    await port.signOut()

    expect(port.state()).toEqual({ status: "unsigned" })
  })

  test("names the operation and forwards its parameters, nothing else", async () => {
    const b = bridge()
    const port = inRoot(() => electronAccountPort(b.api))

    await port.run("workspace.checkpoints.list", { id: "ws_1" })

    expect(b.calls.filter((call) => call.method === "run")).toEqual([
      { method: "run", args: ["workspace.checkpoints.list", { id: "ws_1" }] },
    ])
  })

  test("reports a broken bridge as unavailable, not as signed out", async () => {
    // A failing bridge is a desktop wiring problem. Showing a login screen
    // would send the user to fix the wrong thing.
    const port = inRoot(() =>
      electronAccountPort(
        bridge({
          state: async () => {
            throw new Error("no ipc")
          },
        }).api,
      ),
    )

    await port.refresh()

    expect(port.state()).toMatchObject({ status: "unavailable" })
  })
})

describe("accountBridge", () => {
  test("finds a complete bridge", () => {
    expect(accountBridge({ api: { account: bridge().api } })).toBeDefined()
  })

  test("is undefined in a browser build", () => {
    expect(accountBridge({})).toBeUndefined()
    expect(accountBridge({ api: {} })).toBeUndefined()
  })

  test("rejects a partial bridge instead of using half of it", () => {
    // A preload that changed under a renderer that did not. Failing at startup
    // beats failing the first time someone clicks sign out.
    const { api } = bridge()
    for (const missing of ["state", "signIn", "signOut", "run"] as const) {
      const partial = { ...api, [missing]: undefined }
      expect(accountBridge({ api: { account: partial } }), missing).toBeUndefined()
    }
  })
})
