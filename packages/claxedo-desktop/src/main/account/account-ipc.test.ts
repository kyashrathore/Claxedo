import { describe, expect, test } from "bun:test"
import {
  ACCOUNT_SIGN_IN_CHANNEL,
  ACCOUNT_SIGN_OUT_CHANNEL,
  ACCOUNT_STATE_CHANNEL,
  registerAccountIpc,
  type AccountIpcService,
} from "./account-ipc"
import { HOSTED_OPERATIONS, hostedOperationChannel } from "./hosted-operations"

/**
 * The IPC surface, checked in both directions.
 *
 * Exhaustive is the property: every operation reachable, and NOTHING reachable
 * that is not an operation. A test that only checked the first half would pass
 * with an extra `hostedFetch` channel sitting beside them.
 */

function harness(overrides: Partial<AccountIpcService> = {}) {
  const calls: Array<{ name: string; input: unknown }> = []
  const handlers = new Map<string, (event: never, ...args: never[]) => unknown>()
  const service: AccountIpcService = {
    state: () => ({ status: "signed", identity: { userId: "user_1" } }),
    signIn: async () => ({ ok: true, tokens: { accessToken: "at_1", expiresAt: 1 } }),
    signOut: async () => {},
    run: async (name, input) => {
      calls.push({ name, input })
      return { ran: name }
    },
    ...overrides,
  }
  const registered = registerAccountIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    service,
  })
  return {
    calls,
    registered,
    invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!(undefined as never, ...(args as never[])),
    has: (channel: string) => handlers.has(channel),
    channels: () => [...handlers.keys()],
  }
}

describe("registered channels", () => {
  test("exposes exactly one channel per operation, plus the three account ones", () => {
    // Both directions. An extra channel is the failure that matters, and only
    // an equality check finds it.
    const h = harness()
    const expected = [
      ACCOUNT_STATE_CHANNEL,
      ACCOUNT_SIGN_IN_CHANNEL,
      ACCOUNT_SIGN_OUT_CHANNEL,
      ...Object.keys(HOSTED_OPERATIONS).map((name) => hostedOperationChannel(name as never)),
    ]

    expect(h.channels().toSorted()).toEqual(expected.toSorted())
  })

  test("registers no generic channel", () => {
    const h = harness()

    for (const channel of h.channels()) {
      expect(channel).not.toMatch(/fetch|proxy|invoke|request$/i)
    }
  })
})

describe("operation channels", () => {
  test("bind the operation name at registration, not from the message", () => {
    // The renderer chooses WHICH channel to call. It cannot choose what that
    // channel does — otherwise the closed set is decoration.
    const h = harness()

    h.invoke(hostedOperationChannel("workspace.checkpoints.list"), { id: "ws_1", operation: "account.get" })

    expect(h.calls).toEqual([{ name: "workspace.checkpoints.list", input: { id: "ws_1", operation: "account.get" } }])
  })

  test("pass an empty object when the renderer sends nothing", async () => {
    // Otherwise `undefined` reaches the resolver and a missing-parameter error
    // reads as a crash rather than a bad call.
    const h = harness()

    await h.invoke(hostedOperationChannel("account.get"))

    expect(h.calls[0]).toEqual({ name: "account.get", input: {} })
  })

  test("return whatever the service decoded", async () => {
    const h = harness()

    expect(await h.invoke(hostedOperationChannel("account.mode"))).toEqual({ ran: "account.mode" })
  })
})

describe("account channels", () => {
  test("signIn returns the state, never the token set", async () => {
    // The flow's own result carries tokens. A handler that returned it would
    // put the credential on the IPC boundary — the one thing this arrangement
    // exists to prevent.
    const h = harness()

    const result = await h.invoke(ACCOUNT_SIGN_IN_CHANNEL)

    expect(result).toEqual({ status: "signed", identity: { userId: "user_1" } })
    expect(JSON.stringify(result)).not.toContain("at_1")
    expect(JSON.stringify(result)).not.toContain("accessToken")
  })

  test("signOut returns the state after signing out", async () => {
    let signedOut = false
    const h = harness({
      signOut: async () => {
        signedOut = true
      },
      state: () => (signedOut ? { status: "unsigned" } : { status: "signed", identity: { userId: "user_1" } }),
    })

    expect(await h.invoke(ACCOUNT_SIGN_OUT_CHANNEL)).toEqual({ status: "unsigned" })
  })

  test("state carries no credential", () => {
    const h = harness()

    expect(JSON.stringify(h.invoke(ACCOUNT_STATE_CHANNEL))).not.toMatch(/token|Bearer/i)
  })
})
