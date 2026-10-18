/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { HostedAccount } from "./account"
import { placementId, projectId, sessionId, type ProjectId } from "./ids"
import type { SessionContext } from "./session-context"
import { listFirstPages, listSessions } from "./session-list"

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

type GroupedCall = { readonly operation: string; readonly input: Readonly<Record<string, unknown>> | undefined }

function firstPagesContext(options: { loopback: boolean; links: Record<string, string[]>; pages?: Record<string, readonly unknown[]>; down?: boolean }) {
  const calls: GroupedCall[] = []
  const daemon: string[] = []
  const item = (sessionId: string, workspaceId: string, at: number) => ({
    sessionId, workspaceId, sessionRef: `workspace:${workspaceId}:session:${sessionId}`, directory: `workspace:${workspaceId}`, createdAt: at, updatedAt: at, lastHumanTurnAt: at,
  })
  const account = {
    run: async (operation: string, input?: Readonly<Record<string, unknown>>) => {
      calls.push({ operation, input })
      if (options.down) throw new Error("control plane unreachable")
      if (operation === "session.pages") return { pages: Object.entries(options.pages ?? {}).map(([projectId, items]) => ({ projectId, items })) }
      return { items: [] }
    },
  } as unknown as HostedAccount
  const value = {
    transport: { loopback: options.loopback, json: async (path: string) => (daemon.push(path), { items: [] }) },
    workspaces: {
      address: { placementFor: (_directory: string, workspaceId?: string) => ({ placementId: placementId(workspaceId ?? "none"), projectId: projectId(workspaceId === "ws_b" ? "prj_b" : "prj_a") }) },
      learn: async () => undefined,
      hostSession: () => undefined,
      accountProjectIds: (id: ProjectId) => (options.links[id] ?? []).map(projectId),
    },
    status: { listed: (_ref: unknown, status: unknown) => status },
    account,
  } as unknown as SessionContext
  return { value, calls, daemon, item }
}

test("first pages: a signed browser reads every project's first page as one account read before any project is named, and each project's page is cut from it", async () => {
  const links = { prj_a: ["prj_a"], prj_b: ["prj_b"], prj_c: ["prj_c"] }
  const ctx = firstPagesContext({ loopback: false, links })
  const { item } = ctx
  const pages = { prj_a: [item("ses_a2", "ws_a", 20), item("ses_a1", "ws_a", 10)], prj_b: [item("ses_b1", "ws_b", 5)] }
  const { value, calls } = firstPagesContext({ loopback: false, links, pages })
  const first = listFirstPages(value, { limit: 5, settled: "active" })
  expect(calls).toEqual([{ operation: "session.pages", input: { limit: 5, sort: "human_turn_desc", settled: "active" } }])
  const [a, b, c] = await Promise.all([first.page(projectId("prj_a")), first.page(projectId("prj_b")), first.page(projectId("prj_c"))])
  expect(a.rows.map((row) => String(row.ref.sessionId))).toEqual(["ses_a2", "ses_a1"])
  expect(b.rows.map((row) => String(row.ref.sessionId))).toEqual(["ses_b1"])
  expect(c.rows).toEqual([])
  expect(a.nextAfter).toBeUndefined()
  expect(calls).toHaveLength(1)
  expect(ctx.daemon).toEqual([])
})

test("first pages: an account that cannot answer fails every account-only project's page with its reason", async () => {
  const { value } = firstPagesContext({ loopback: false, links: { prj_a: ["prj_a"] }, down: true })
  const original = console.warn
  const warned: unknown[] = []
  console.warn = (...args: unknown[]) => void warned.push(args)
  try {
    const first = listFirstPages(value, { limit: 5, settled: "active" })
    await expect(first.page(projectId("prj_a"))).rejects.toThrow("control plane unreachable")
    await Promise.resolve()
  } finally {
    console.warn = original
  }
  expect(warned).toHaveLength(1)
})

test("first pages: a signed desktop reads the account's pages once a project asks, settled=all beside the daemon's page for a paired project and under the reader's filter for an account-only one", async () => {
  const { value, calls, daemon } = firstPagesContext({ loopback: true, links: { local_1: ["prj_cp"], prj_only: ["prj_only"] } })
  const first = listFirstPages(value, { limit: 5, settled: "active" })
  expect(calls).toEqual([])
  await first.page(projectId("local_1"))
  expect(daemon).toEqual(["/api/claxedo/session-list?scope=project&projectId=local_1&sort=human_turn_desc&limit=5&settled=all"])
  expect(calls).toEqual([{ operation: "session.pages", input: { limit: 5, sort: "human_turn_desc", settled: "all" } }])
  await first.page(projectId("prj_only"))
  expect(calls.map((call) => call.input?.settled)).toEqual(["all", "active"])
  expect(calls.every((call) => call.operation === "session.pages")).toBe(true)
})
