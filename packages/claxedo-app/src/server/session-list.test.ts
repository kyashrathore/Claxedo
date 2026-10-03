/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { HostedAccount } from "./account"
import { projectId, sessionId, type ProjectId } from "./ids"
import type { SessionContext } from "./session-context"
import { listSessions } from "./session-list"

function context(options: { links?: Record<string, string[]>; account?: "up" | "down" }) {
  const daemon: string[] = []
  const account: Array<Readonly<Record<string, unknown>> | undefined> = []
  const hosted = {
    run: async (_operation: string, input?: Readonly<Record<string, unknown>>) => {
      account.push(input)
      if (options.account === "down") throw new Error("control plane unreachable")
      return { items: [] }
    },
  } as unknown as HostedAccount
  const value = {
    transport: {
      loopback: true,
      json: async (path: string) => {
        daemon.push(path)
        return { items: [] }
      },
    },
    workspaces: {
      address: { placementFor: () => undefined },
      learn: async () => undefined,
      accountProjectIds: (id: ProjectId) => (options.links?.[id] ?? []).map(projectId),
    },
    status: { listed: (_ref: unknown, status: unknown) => status },
    ...(options.account ? { account: hosted } : {}),
  } as unknown as SessionContext
  return { value, daemon, account }
}

test("session list: an unsigned server is the one source", async () => {
  const { value, daemon, account } = context({})
  await listSessions(value, { projectId: projectId("local_1"), limit: 5, settled: "active" })
  expect(daemon).toEqual(["/api/claxedo/session-list?scope=project&projectId=local_1&sort=human_turn_desc&limit=5&settled=active"])
  expect(account).toEqual([])
})

test("session list: a paired local project reads the daemon's page and each linked account project's, under one key", async () => {
  const { value, daemon, account } = context({ links: { local_1: ["prj_cp"] }, account: "up" })
  const page = await listSessions(value, { projectId: projectId("local_1"), limit: 5, after: "k", settled: "active" })
  expect(daemon).toEqual(["/api/claxedo/session-list?scope=project&projectId=local_1&sort=human_turn_desc&limit=5&settled=all&after=k"])
  expect(account).toEqual([{ projectId: "prj_cp", limit: 5, settled: "all", sort: "human_turn_desc", after: "k" }])
  expect(page.degraded).toBeUndefined()
})

test("session list: an account-only project skips the daemon, and a failed account page fails it", async () => {
  const { value, daemon, account } = context({ links: { prj_cp: ["prj_cp"] }, account: "up" })
  await listSessions(value, { projectId: projectId("prj_cp"), limit: 5, settled: "active" })
  expect(daemon).toEqual([])
  expect(account).toEqual([{ projectId: "prj_cp", limit: 5, settled: "active", sort: "human_turn_desc" }])

  const down = context({ links: { prj_cp: ["prj_cp"] }, account: "down" })
  await expect(listSessions(down.value, { projectId: projectId("prj_cp"), limit: 5, settled: "active" })).rejects.toThrow("control plane unreachable")
})

test("session list: a paired project whose account page fails lists the daemon's rows, degraded", async () => {
  const { value } = context({ links: { local_1: ["prj_cp"] }, account: "down" })
  const page = await listSessions(value, { projectId: projectId("local_1"), limit: 5, settled: "active" })
  expect(page.degraded).toBe(true)
  expect(page.rows).toEqual([])
})

test("session list: every listed session's host, its own or its workspace, is recorded from its row", async () => {
  const hosted: Array<[unknown, string | undefined]> = []
  const item = (sessionId: string, extra: Record<string, unknown> = {}) => ({
    sessionId, sessionRef: `workspace:ws_cloud:session:${sessionId}`, directory: "workspace:ws_cloud", workspaceId: "ws_cloud", createdAt: 1, updatedAt: 2, ...extra,
  })
  const value = {
    transport: { loopback: true, json: async () => ({ items: [item("ses_pi", { sessionHostRoot: "ses_pi" }), item("ses_codex")] }) },
    workspaces: {
      address: { placementFor: () => ({ placementId: "ws_cloud", projectId: "prj_1" }) },
      learn: async () => undefined,
      accountProjectIds: () => [],
      hostSession: (ref: unknown, root: string | undefined) => hosted.push([ref, root]),
    },
    status: { listed: (_ref: unknown, status: unknown) => status },
  } as unknown as SessionContext
  const page = await listSessions(value, { projectId: projectId("prj_1"), limit: 5, settled: "all" })
  expect(page.rows.map((row) => String(row.ref.sessionId)).toSorted()).toEqual(["ses_codex", "ses_pi"])
  expect(hosted.toSorted((a, b) => String(a[1]).localeCompare(String(b[1])))).toEqual([
    [{ projectId: "prj_1", placementId: "ws_cloud", sessionId: "ses_pi" }, "ses_pi"],
    [{ projectId: "prj_1", placementId: "ws_cloud", sessionId: "ses_codex" }, undefined],
  ])
})

test("session list: every readable session is one all-scoped read of the server, and a signed desktop adds its account's under the reader's own settled filter", async () => {
  const unsigned = context({})
  await listSessions(unsigned.value, { every: true, limit: 20, settled: "active" })
  expect(unsigned.daemon).toEqual(["/api/claxedo/session-list?scope=all&sort=human_turn_desc&limit=20&settled=active"])

  const signed = context({ account: "up" })
  await listSessions(signed.value, { every: true, sessionId: sessionId("ses_1"), limit: 1, settled: "active" })
  expect(signed.daemon).toEqual(["/api/claxedo/session-list?scope=all&sessionId=ses_1&sort=human_turn_desc&limit=1&settled=active"])
  expect(signed.account).toEqual([{ limit: 1, settled: "active", sessionId: "ses_1", sort: "human_turn_desc" }])
})
