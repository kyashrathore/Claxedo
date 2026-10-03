/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { HostedAccount } from "./account"
import { projectId, type ProjectId } from "./ids"
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
      accountWorkspaceIds: () => [],
      accountProjectIds: (id: ProjectId) => (options.links?.[id] ?? []).map(projectId),
    },
    status: { listed: (_ref: unknown, status: unknown) => status },
    ...(options.account ? { account: hosted } : {}),
  } as unknown as SessionContext
  return { value, daemon, account }
}

test("session list: an unsigned server is the one source", async () => {
  const { value, daemon, account } = context({})
  await listSessions(value, { projectId: projectId("local_1"), limit: 5 })
  expect(daemon).toEqual(["/api/claxedo/session-list?scope=project&projectId=local_1&sort=human_turn_desc&limit=5"])
  expect(account).toEqual([])
})

test("session list: a paired local project reads the daemon's page and each linked account project's, under one key", async () => {
  const { value, daemon, account } = context({ links: { local_1: ["prj_cp"] }, account: "up" })
  const page = await listSessions(value, { projectId: projectId("local_1"), limit: 5, after: "k" })
  expect(daemon).toEqual(["/api/claxedo/session-list?scope=project&projectId=local_1&sort=human_turn_desc&limit=5&after=k"])
  expect(account).toEqual([{ projectId: "prj_cp", limit: 5, sort: "human_turn_desc", after: "k" }])
  expect(page.degraded).toBeUndefined()
})

test("session list: an account-only project skips the daemon, and a failed account page fails it", async () => {
  const { value, daemon, account } = context({ links: { prj_cp: ["prj_cp"] }, account: "up" })
  await listSessions(value, { projectId: projectId("prj_cp"), limit: 5 })
  expect(daemon).toEqual([])
  expect(account).toEqual([{ projectId: "prj_cp", limit: 5, sort: "human_turn_desc" }])

  const down = context({ links: { prj_cp: ["prj_cp"] }, account: "down" })
  await expect(listSessions(down.value, { projectId: projectId("prj_cp"), limit: 5 })).rejects.toThrow("control plane unreachable")
})

test("session list: a paired project whose account page fails lists the daemon's rows, degraded", async () => {
  const { value } = context({ links: { local_1: ["prj_cp"] }, account: "down" })
  const page = await listSessions(value, { projectId: projectId("local_1"), limit: 5 })
  expect(page.degraded).toBe(true)
  expect(page.rows).toEqual([])
})
