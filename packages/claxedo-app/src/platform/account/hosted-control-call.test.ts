import { afterEach, describe, expect, mock, test } from "bun:test"
import { hostedControlCall } from "./hosted-control-call"

const originalApi = (globalThis as { api?: unknown }).api

afterEach(() => {
  if (originalApi === undefined) delete (globalThis as { api?: unknown }).api
  else (globalThis as { api?: unknown }).api = originalApi
})

function installBridge(run: (operation: string, input?: Record<string, unknown>) => Promise<unknown>) {
  ;(globalThis as { api?: { account: Record<string, unknown> } }).api = {
    account: {
      run,
      state: async () => ({ status: "signed" }),
      onState: () => () => undefined,
      signIn: async () => ({ status: "signed" }),
      signOut: async () => ({ status: "unsigned" }),
    },
  }
}

describe("hostedControlCall", () => {
  test("uses the complete AccountPort bridge and decodes its named result", async () => {
    const run = mock(async () => ({ can_manage_shares: true, grants: [], participants: [], teams: [] }))
    const fallback = mock(async () => ({ can_manage_shares: true, grants: ["fallback"], participants: [], teams: [] }))
    installBridge(run)

    await expect(hostedControlCall("session.shares.list", {
      sessionId: "ses_1",
      workspaceId: "ws_1",
    }, fallback)).resolves.toEqual({ can_manage_shares: true, grants: [], participants: [], teams: [] })

    expect(run).toHaveBeenCalledWith("session.shares.list", { sessionId: "ses_1", workspaceId: "ws_1" })
    expect(fallback).not.toHaveBeenCalled()
  })

  test("uses the caller fallback when no complete AccountPort bridge is present", async () => {
    delete (globalThis as { api?: unknown }).api
    const fallback = mock(async () => ({ can_manage_shares: true, grants: ["browser"], participants: [], teams: [] }))

    await expect(hostedControlCall("session.shares.list", {}, fallback)).resolves.toEqual({
      grants: ["browser"],
      participants: [],
      can_manage_shares: true,
      teams: [],
    })

    expect(fallback).toHaveBeenCalledTimes(1)
  })
})
