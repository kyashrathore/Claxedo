import { afterEach, describe, expect, mock, test } from "bun:test"
import { listSessionShares } from "./session-share-api"

const originalApi = (globalThis as { api?: unknown }).api

afterEach(() => {
  if (originalApi === undefined) delete (globalThis as { api?: unknown }).api
  else (globalThis as { api?: unknown }).api = originalApi
})

describe("listSessionShares", () => {
  test("uses the named AccountPort operation in signed desktop mode", async () => {
    const result = { can_manage_shares: false as const, grants: [], participants: [], teams: [] }
    const run = mock(async () => result)
    ;(globalThis as { api?: { account: Record<string, unknown> } }).api = {
      account: {
        run,
        state: async () => ({ status: "signed" }),
        onState: () => () => undefined,
        signIn: async () => ({ status: "signed" }),
        signOut: async () => ({ status: "unsigned" }),
      },
    }

    await expect(listSessionShares("ses_1", "ws_1")).resolves.toEqual(result)
    expect(run).toHaveBeenCalledWith("session.shares.list", { sessionId: "ses_1", workspaceId: "ws_1" })
  })
})
