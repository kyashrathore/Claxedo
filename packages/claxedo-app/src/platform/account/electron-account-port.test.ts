import { describe, expect, test } from "bun:test"
import { createRoot, flush } from "solid-js"
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
  const listeners = new Set<(state: Awaited<ReturnType<AccountBridge["state"]>>) => void>()
  const api: AccountBridge = {
    state: async () => {
      calls.push({ method: "state", args: [] })
      return { status: "signed", identity: { userId: "user_1", email: "a@b.test" } }
    },
    onState: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
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
      // A shape the registry's decoder accepts for this operation. Returning
      // something arbitrary would make the port's decode step fail here, which
      // is the decode step working. `workspace.checkpoints.list` answers the
      // lifecycle SNAPSHOT, not a list — the name is about the route, not the
      // shape.
      return { ran: operation }
    },
    ...overrides,
  }
  return {
    api,
    calls,
    emit: (state: Awaited<ReturnType<AccountBridge["state"]>>) => listeners.forEach((listener) => listener(state)),
  }
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

    flush()
    expect(port.state()).toEqual({ status: "pending" })
  })

  test("adopts the state main reports", async () => {
    const port = inRoot(() => electronAccountPort(bridge().api))

    await port.refresh()

    flush()
    expect(port.state()).toMatchObject({ status: "signed", identity: { email: "a@b.test" } })
  })

  test("updates after sign out rather than keeping a stale identity", async () => {
    // Main owns the state. A port that only read it once would keep showing a
    // signed-in email after the credential was cleared.
    const port = inRoot(() => electronAccountPort(bridge().api))
    await port.refresh()

    await port.signOut()

    flush()
    expect(port.state()).toEqual({ status: "unsigned" })
  })

  test("adopts passive revocation pushed by Electron main", async () => {
    const b = bridge()
    let dispose!: () => void
    const port = createRoot((cleanup) => {
      dispose = cleanup
      return electronAccountPort(b.api)
    })
    await port.refresh()

    b.emit({ status: "unavailable", reason: "revoked" })

    // Solid 2 stages the signal write the push handler makes until the
    // scheduler flushes; the account UI reads `state()` from a memo, after one.
    flush()
    expect(port.state()).toEqual({ status: "unavailable", reason: "revoked" })
    dispose()
  })

  test("does not overwrite a pushed revocation with an older state response", async () => {
    let resolveState!: (state: Awaited<ReturnType<AccountBridge["state"]>>) => void
    const pendingState = new Promise<Awaited<ReturnType<AccountBridge["state"]>>>((resolve) => {
      resolveState = resolve
    })
    const b = bridge({ state: () => pendingState })
    let dispose!: () => void
    const port = createRoot((cleanup) => {
      dispose = cleanup
      return electronAccountPort(b.api)
    })

    b.emit({ status: "unavailable", reason: "revoked" })
    resolveState({ status: "signed", identity: { userId: "stale" } })
    await Promise.resolve()
    await Promise.resolve()

    flush()
    expect(port.state()).toEqual({ status: "unavailable", reason: "revoked" })
    dispose()
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

    flush()
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
    for (const missing of ["state", "onState", "signIn", "signOut", "run"] as const) {
      const partial = { ...api, [missing]: undefined }
      expect(accountBridge({ api: { account: partial } }), missing).toBeUndefined()
    }
  })
})
