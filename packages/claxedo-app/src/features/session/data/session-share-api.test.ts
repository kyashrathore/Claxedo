import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

const calls: Array<{ url: string; method?: string; body?: string }> = []

// Bun's mock.module registry is process-wide, so this mock stays a faithful
// superset of the real module: captured through a cache-busting query, spread
// whole so every named export keeps resolving for later-loaded suites, with
// only the network boundary and the server URL overridden.
const realApiModule = { ...(await import(`${import.meta.dir}/../../../platform/api/api.ts?session-share-restore`)) }
afterAll(async () => {
  await mock.module("@/platform/api/api", () => realApiModule)
})

await mock.module("@/platform/api/api", () => ({
  ...realApiModule,
  authFetch: async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    })
    return new Response(JSON.stringify({ grant_id: "ssg_1", level: "send" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  },
  getClaxedoServerUrl: () => "https://api.example.test",
}))

const { grantSessionShare, listSessionShares } = await import("./session-share-api")

const originalApi = (globalThis as { api?: unknown }).api

function signedAccount(run: (operation: string, input?: Record<string, unknown>) => Promise<unknown>) {
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

beforeEach(() => {
  calls.length = 0
})

afterEach(() => {
  if (originalApi === undefined) delete (globalThis as { api?: unknown }).api
  else (globalThis as { api?: unknown }).api = originalApi
})

describe("listSessionShares", () => {
  test("uses the named AccountPort operation in signed desktop mode", async () => {
    const result = { can_manage_shares: false as const, grants: [], participants: [], teams: [] }
    const run = mock(async () => result)
    signedAccount(run)

    await expect(listSessionShares("ses_1", "ws_1")).resolves.toEqual(result)
    expect(run).toHaveBeenCalledWith("session.shares.list", { sessionId: "ses_1", workspaceId: "ws_1" })
  })
})

describe("grantSessionShare", () => {
  test("carries the level to the AccountPort operation on a signed desktop", async () => {
    const run = mock(async () => ({ grant_id: "ssg_1", level: "send" }))
    signedAccount(run)

    await grantSessionShare({
      sessionId: "ses_1",
      workspaceId: "ws_1",
      level: "send",
      grantedToUserId: "user_bob",
    })

    expect(run).toHaveBeenCalledWith("session.shares.grant", {
      sessionId: "ses_1",
      workspaceId: "ws_1",
      level: "send",
      grantedToUserId: "user_bob",
    })
    expect(calls).toEqual([])
  })

  test("carries the level in the POST body in the browser", async () => {
    delete (globalThis as { api?: unknown }).api

    await grantSessionShare({
      sessionId: "ses_1",
      workspaceId: "ws_1",
      level: "send",
      grantedToTokenIdentifier: "https://issuer.test|user_bob",
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe("POST")
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({
      workspaceId: "ws_1",
      level: "send",
      grantedToTokenIdentifier: "https://issuer.test|user_bob",
    })
  })

  test("sends follow as itself rather than omitting it", async () => {
    delete (globalThis as { api?: unknown }).api

    await grantSessionShare({
      sessionId: "ses_1",
      workspaceId: "ws_1",
      level: "follow",
      grantedToTeamPublicId: "team_eng",
    })

    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({
      workspaceId: "ws_1",
      level: "follow",
      grantedToTeamPublicId: "team_eng",
    })
  })
})
