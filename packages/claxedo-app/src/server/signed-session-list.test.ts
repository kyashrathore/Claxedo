/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { HostedAccount } from "./account"
import { placementId, projectId, sessionId, type ProjectId } from "./ids"
import type { SessionContext } from "./session-context"
import { listSessions } from "./session-list"
import { sendReaderWrite } from "./session-reader"
import { compareListOrder, listOrderKey, type ListOrderKey } from "./wire/list-order"

type Item = ReturnType<typeof item>

function item(id: string, workspaceId: string, ref: string, at: number, marks: Record<string, number> = {}) {
  return { sessionId: id, workspaceId, sessionRef: ref, directory: "/work", createdAt: at, updatedAt: at, lastHumanTurnAt: at, lastTurn: { status: "completed", completedAt: at + 1 }, ...marks }
}

const local = (id: string, workspaceId: string, at: number, marks?: Record<string, number>) => item(id, workspaceId, `local:/work:session:${id}`, at, marks)
const hosted = (id: string, workspaceId: string, at: number, marks?: Record<string, number>) => item(id, workspaceId, `workspace:${workspaceId}:session:${id}`, at, marks)

function decodedAfter(after: unknown): ListOrderKey | undefined {
  if (typeof after !== "string") return undefined
  const padded = after.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(after.length / 4) * 4, "=")
  return JSON.parse(atob(padded)) as ListOrderKey
}

function paged(items: readonly Item[], after: unknown, limit: number) {
  const key = decodedAfter(after)
  const rest = [...items]
    .sort((a, b) => compareListOrder(listOrderKey(a)!, listOrderKey(b)!))
    .filter((entry) => !key || compareListOrder(listOrderKey(entry)!, key) > 0)
  return { items: rest.slice(0, limit), ...(rest.length > limit ? { nextAfter: "more" } : {}) }
}

function signedDesktop(sources: { daemon: readonly Item[]; account: readonly Item[] | "down" }) {
  const writes: Array<{ to: string; body: unknown }> = []
  const account = {
    run: async (operation: string, input: Readonly<Record<string, unknown>> = {}) => {
      if (operation !== "session.page" && operation !== "session.activity.page") return writes.push({ to: operation, body: input }), { seenAt: 70 }
      if (sources.account === "down") throw new Error("control plane unreachable")
      const listed = input.settled === "active" ? sources.account.filter((entry) => !("settledAt" in entry)) : sources.account
      return paged(listed, input.after, Number(input.limit))
    },
  } as unknown as HostedAccount
  const value = {
    transport: {
      loopback: true,
      json: async (path: string, init?: RequestInit) => {
        const url = new URL(path, "http://daemon.test")
        if (url.pathname !== "/api/claxedo/session-list") return writes.push({ to: url.pathname, body: JSON.parse(typeof init?.body === "string" ? init.body : "") }), { seenAt: 70 }
        return paged(sources.daemon, url.searchParams.get("after") ?? undefined, Number(url.searchParams.get("limit")))
      },
    },
    workspaces: {
      address: { placementFor: (_directory: string, workspaceId?: string) => ({ placementId: placementId(workspaceId ?? "none"), projectId: projectId("local_1") }) },
      learn: async () => undefined,
      hostSession: () => undefined,
      accountProjectIds: (id: ProjectId) => (id === "local_1" ? [projectId("prj_cp")] : []),
      accountKnows: (workspaceId: string) => workspaceId === "ws_published",
      home: async (ref: { placementId: string }) => ({ route: { workspaceId: ref.placementId, directory: "/work", remote: false } }),
    },
    status: { listed: (_ref: unknown, status: unknown) => status },
    account,
  } as unknown as SessionContext
  return { value, writes }
}

const ids = (rows: readonly { readonly ref: { readonly sessionId: string } }[]) => rows.map((row) => row.ref.sessionId)

test("signed list: a published session from both sources is one row, with the account's marks; what the account settled is hidden", async () => {
  const { value } = signedDesktop({
    daemon: [local("ses_seen", "ws_published", 90, { seenAt: 5 }), local("ses_settled", "ws_published", 80), local("ses_machine", "ws_unpublished", 70, { seenAt: 71 })],
    account: [hosted("ses_seen", "ws_published", 90, { seenAt: 91 }), hosted("ses_settled", "ws_published", 80, { settledAt: 81 })],
  })
  const active = await listSessions(value, { projectId: projectId("local_1"), limit: 10, settled: "active" })
  expect(ids(active.rows)).toEqual(["ses_seen", "ses_machine"])
  expect(active.nextAfter).toBeUndefined()

  const all = await listSessions(value, { projectId: projectId("local_1"), limit: 10, settled: "all" })
  expect(ids(all.rows)).toEqual(["ses_seen", "ses_settled", "ses_machine"])
  expect(Object.fromEntries(all.readers)).toEqual({ ses_seen: { seenAt: 91 }, ses_settled: { settledAt: 81 }, ses_machine: { seenAt: 71 } })
})

test("signed Activity: the account answers its own sessions under the reader's settled filter, and the machine only the sessions the account does not know", async () => {
  const { value } = signedDesktop({
    daemon: [local("ses_seen", "ws_published", 90, { seenAt: 5 }), local("ses_settled", "ws_published", 80), local("ses_machine", "ws_unpublished", 70, { seenAt: 71 })],
    account: [hosted("ses_seen", "ws_published", 90, { seenAt: 91 }), hosted("ses_settled", "ws_published", 80, { settledAt: 81 })],
  })
  const page = await listSessions(value, { every: true, limit: 10, settled: "active" })
  expect(ids(page.rows)).toEqual(["ses_seen", "ses_machine"])
  expect(Object.fromEntries(page.readers)).toEqual({ ses_seen: { seenAt: 91 }, ses_machine: { seenAt: 71 } })
})

test("signed list: a page whose first rows the account settled fills from the rows after them", async () => {
  const sessions = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `s${n}`, at: 100 - n }))
  const { value } = signedDesktop({
    daemon: sessions.map(({ id, at }) => local(id, "ws_published", at)),
    account: sessions.map(({ id, at }, index) => hosted(id, "ws_published", at, index < 5 ? { settledAt: 1_000 } : {})),
  })
  const page = await listSessions(value, { projectId: projectId("local_1"), limit: 5, settled: "active" })
  expect(ids(page.rows)).toEqual(["s6", "s7"])
  expect(page.nextAfter).toBeUndefined()
})

test("signed list: an account page that fails leaves the published sessions' stored marks alone and hides nothing", async () => {
  const { value } = signedDesktop({
    daemon: [local("ses_seen", "ws_published", 90, { seenAt: 5 }), local("ses_machine", "ws_unpublished", 70, { seenAt: 71 })],
    account: "down",
  })
  const page = await listSessions(value, { projectId: projectId("local_1"), limit: 10, settled: "active" })
  expect(ids(page.rows)).toEqual(["ses_seen", "ses_machine"])
  expect(page.degraded).toBe(true)
  expect(Object.fromEntries(page.readers)).toEqual({ ses_machine: { seenAt: 71 } })
})

test("signed list: a published session's marks go to the account, an unpublished one's to this machine, with the activity the reader settled through", async () => {
  const { value, writes } = signedDesktop({ daemon: [], account: [] })
  const ref = (workspaceId: string) => ({ projectId: projectId("local_1"), placementId: placementId(workspaceId), sessionId: sessionId("ses_1") })
  await sendReaderWrite(value, ref("ws_published"), { kind: "seen", completedAt: 70 })
  await sendReaderWrite(value, ref("ws_unpublished"), { kind: "settle", settled: true, through: 90 })
  await sendReaderWrite(value, ref("ws_published"), { kind: "settle", settled: false })
  expect(writes).toEqual([
    { to: "session.seen", body: { sessionId: "ses_1", completedAt: 70 } },
    { to: "/api/claxedo/session/ses_1/settle", body: { settled: true, through: 90 } },
    { to: "session.settle", body: { sessionId: "ses_1", settled: false } },
  ])
})
