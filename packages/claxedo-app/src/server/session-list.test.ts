/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { HostedAccount } from "./account"
import { placementId, projectId, sessionId, type ProjectId } from "./ids"
import type { SessionContext } from "./session-context"
import { listSessions } from "./session-list"
import { sendReaderWrite } from "./session-reader"

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

function signedDesktop(pages: { daemon: unknown[]; account: unknown[] }) {
  const daemon: string[] = []
  const account: Array<{ operation: string; input?: Readonly<Record<string, unknown>> }> = []
  const hosted = {
    run: async (operation: string, input?: Readonly<Record<string, unknown>>) => {
      account.push({ operation, input })
      return operation === "session.page" ? { items: pages.account } : { seenAt: 70 }
    },
  } as unknown as HostedAccount
  const value = {
    transport: {
      loopback: true,
      json: async (path: string) => {
        daemon.push(path)
        return path.includes("/session-list") ? { items: pages.daemon } : { seenAt: 70 }
      },
    },
    workspaces: {
      address: { placementFor: (_directory: string, workspaceId?: string) => ({ placementId: placementId(workspaceId ?? "none"), projectId: projectId("local_1") }) },
      learn: async () => undefined,
      accountProjectIds: (id: ProjectId) => (id === "local_1" ? [projectId("prj_cp")] : []),
      accountKnows: (workspaceId: string) => workspaceId === "ws_published",
      home: async (ref: { placementId: string }) => ({ route: { workspaceId: ref.placementId, directory: "/work", remote: false } }),
    },
    status: { listed: (_ref: unknown, status: unknown) => status },
    account: hosted,
  } as unknown as SessionContext
  return { value, daemon, account }
}

function item(sessionId: string, workspaceId: string, sessionRef: string, marks: Record<string, number>) {
  return { sessionId, workspaceId, sessionRef, directory: "/work", createdAt: 1, updatedAt: 1, lastHumanTurnAt: 60, lastTurn: { status: "completed", completedAt: 70 }, ...marks }
}

test("session list: a signed desktop takes a published session's marks from the account and hides what the account settled", async () => {
  const { value, daemon, account } = signedDesktop({
    daemon: [
      item("ses_seen", "ws_published", "local:/work:session:ses_seen", { seenAt: 5 }),
      item("ses_settled", "ws_published", "local:/work:session:ses_settled", {}),
      item("ses_machine", "ws_unpublished", "local:/work:session:ses_machine", { seenAt: 70, settledAt: 70 }),
    ],
    account: [
      item("ses_seen", "ws_published", "workspace:ws_published:session:ses_seen", { seenAt: 70 }),
      item("ses_settled", "ws_published", "workspace:ws_published:session:ses_settled", { settledAt: 70 }),
    ],
  })
  const page = await listSessions(value, { projectId: projectId("local_1"), limit: 10, settled: "active" })
  expect(daemon).toEqual(["/api/claxedo/session-list?scope=project&projectId=local_1&sort=human_turn_desc&limit=10&settled=all"])
  expect(account[0]?.input).toMatchObject({ settled: "all" })
  expect([...new Set(page.rows.map((row) => row.ref.sessionId as string))]).toEqual(["ses_seen"])
  expect(page.readers.get(sessionId("ses_seen"))).toEqual({ seenAt: 70 })

  const all = await listSessions(value, { projectId: projectId("local_1"), limit: 10, settled: "all" })
  expect(Object.fromEntries([...all.readers].map(([id, reader]) => [id, reader]))).toEqual({
    ses_seen: { seenAt: 70 },
    ses_settled: { settledAt: 70 },
    ses_machine: { seenAt: 70, settledAt: 70 },
  })
})

test("session reader: a signed desktop writes a published session's mark to the account and an unpublished one's to this machine", async () => {
  const { value, daemon, account } = signedDesktop({ daemon: [], account: [] })
  const ref = (workspaceId: string) => ({ projectId: projectId("local_1"), placementId: placementId(workspaceId), sessionId: sessionId("ses_1") })
  await expect(sendReaderWrite(value, ref("ws_published"), { kind: "seen", completedAt: 70 })).resolves.toEqual({ seenAt: 70 })
  await expect(sendReaderWrite(value, ref("ws_unpublished"), { kind: "settle", settled: true })).resolves.toEqual({ seenAt: 70 })
  expect(account).toEqual([{ operation: "session.seen", input: { sessionId: "ses_1", completedAt: 70 } }])
  expect(daemon).toEqual(["/api/claxedo/session/ses_1/settle"])
})
