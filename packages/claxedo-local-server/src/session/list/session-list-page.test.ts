import { afterAll, describe, expect, test } from "vitest"
import { execFileSync } from "child_process"
import { mkdirSync, realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import type { RuntimeStatusPath } from "../runtime-activity"
import { machineDisplayName } from "@claxedo/helpers/machine-name"

const root = path.join(realpathSync(os.tmpdir()), `session-list-page-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = { CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR, CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR }
process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
const { putSessionMeta, syncSessionMeta } = await import("@claxedo/server-core/session/meta/index")
const { ensureWorkspace, upsertProjectRecord } = await import("@claxedo/server-core/workspace/store/index")
const { parseSessionListQuery } = await import("@claxedo/server-core/session/navigation-list")
const { localSessionListPage } = await import("./session-list-page")
ClaxedoDB.Drizzle()

afterAll(async () => {
  ClaxedoDB.close()
  for (const [key, value] of Object.entries(prev)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await fs.rm(root, { recursive: true, force: true })
})

async function workspace(name: string) {
  const directory = path.join(root, `${name}-${randomUUID()}`)
  await fs.mkdir(directory, { recursive: true })
  execFileSync("git", ["init", "-b", "main"], { cwd: directory, stdio: "ignore" })
  const created = await ensureWorkspace({ workspaceId: `ws_${name}_${randomUUID()}`, directory })
  if (!created) throw new Error("test workspace was not created")
  return created
}

function runtime(answers: Record<string, Partial<Record<RuntimeStatusPath, unknown>>>) {
  const reads: string[] = []
  return {
    reads,
    read: async (workspaceId: string, readPath: RuntimeStatusPath) => {
      reads.push(`${workspaceId}${readPath}`)
      const answer = answers[workspaceId]
      if (!answer) return undefined
      return Response.json(answer[readPath] ?? (readPath === "/session/status" ? {} : []))
    },
  }
}

describe("localSessionListPage", () => {
  test("the local inventory includes offline local records and excludes cached cloud records before paging and counts", async () => {
    const local = await workspace("local_population")
    const cloud = await ensureWorkspace({ workspaceId: `ws_cloud_${randomUUID()}`, directory: "workspace:cached-cloud", remote_directory: "/workspace", kind: "cloud", driver: "modal" })
    if (!cloud) throw new Error("test cloud workspace was not created")
    await putSessionMeta("ses_local_population", { ws: local, title: "Population local", createdAt: 100, updatedAt: 100 })
    await putSessionMeta("ses_cloud_population", { ws: cloud, title: "Population cloud", createdAt: 200, updatedAt: 200 })
    const page = await localSessionListPage({ query: parseSessionListQuery(new URL("http://daemon/session-list?scope=all&search=Population&limit=1")),
      workspace: undefined, projectWorkspaces: async () => [local, cloud], readRuntimeStatus: runtime({}).read })
    expect(page.items.map((row) => row.sessionId)).toEqual(["ses_local_population"])
    expect(page.items[0]?.executionAvailability?.status).toBe("offline")
    expect(page.items[0]?.attention).toBeUndefined()
    expect(page.totalKnown).toEqual(1)
    expect(page.nextCursor).toBeUndefined()
  })
  test("offline and available unsettled attention both page through Needs with their canonical availability intact", async () => {
    const online = await workspace("online_attention")
    const offline = await workspace("offline_attention")
    const facts = { sequence: 10, generation: 1, activitySequence: 10, activityAt: 500, working: true, awaitingInput: true }
    await syncSessionMeta(online, { id: "ses_online_attention", title: "Online attention", time: { created: 100, updated: 500 }, attention: facts })
    await syncSessionMeta(offline, { id: "ses_offline_attention", title: "Offline attention", time: { created: 200, updated: 500 }, attention: facts })
    const reads = runtime({ [online.id]: { "/session/status": { ses_online_attention: { type: "busy" } }, "/question": [{ id: "question", sessionID: "ses_online_attention" }] } })
    const input = { workspace: undefined, projectWorkspaces: async () => [online, offline], readRuntimeStatus: reads.read }
    const url = new URL("http://daemon/session-list?scope=all&search=attention&sort=human_turn_desc&settled=active&limit=1")
    const waiting = await localSessionListPage({ ...input, query: parseSessionListQuery(url) })
    expect(waiting.items.map((row) => row.sessionId)).toEqual(["ses_offline_attention"])
    expect(waiting.items[0]).toMatchObject({ attention: facts, executionAvailability: { status: "offline" } })
    expect(waiting.totalKnown).toEqual(2)
    expect(waiting.nextCursor).toBeTruthy()
    url.searchParams.set("after", waiting.nextCursor!)
    const next = await localSessionListPage({ ...input, query: parseSessionListQuery(url) })
    expect(next.items.map((row) => row.sessionId)).toEqual(["ses_online_attention"])
    expect(next.items[0]).toMatchObject({ attention: facts, executionAvailability: { status: "available" } })
    expect(next.totalKnown).toEqual(waiting.totalKnown)
    expect(next.nextCursor).toBeUndefined()
    const unavailable = await localSessionListPage({ ...input, query: parseSessionListQuery(new URL("http://daemon/session-list?scope=all&search=Offline%20attention&limit=1")) })
    expect(unavailable.items[0]).toMatchObject({ sessionId: "ses_offline_attention", attention: facts, executionAvailability: { status: "offline" } })
    expect(unavailable.totalKnown).toEqual(1)
  })
  test("each row carries the status its runtime holds, read once per workspace in process", async () => {
    const running = await workspace("running")
    const asleep = await workspace("asleep")
    await putSessionMeta("ses_busy", { ws: running, title: "Busy", createdAt: 1, updatedAt: 1 })
    await putSessionMeta("ses_asking", { ws: running, title: "Asking", createdAt: 1, updatedAt: 1 })
    await putSessionMeta("ses_quiet", { ws: running, title: "Quiet", createdAt: 1, updatedAt: 1 })
    await putSessionMeta("ses_background", { ws: running, title: "Background", createdAt: 1, updatedAt: 1 })
    await putSessionMeta("ses_asleep", { ws: asleep, title: "Asleep", createdAt: 1, updatedAt: 1 })
    const fake = runtime({
      [running.id]: {
        "/session/status": { ses_busy: { type: "busy" }, ses_background: { type: "idle", backgroundWork: { agents: 2, shells: 0, other: 0 } } },
        "/question": [{ id: "que_1", sessionID: "ses_asking" }],
      },
    })

    const page = await Promise.all([running, asleep].map((ws) => localSessionListPage({
      query: parseSessionListQuery(new URL(`http://daemon.test/api/claxedo/session-list?scope=workspace&workspaceId=${ws.id}&limit=10`)),
      workspace: ws,
      projectWorkspaces: async () => [],
      readRuntimeStatus: fake.read,
      now: () => 7_000,
    })))
    const statuses = Object.fromEntries(page.flatMap((response) => response.items ?? []).map((row) => [row.sessionId, row.status]))

    expect(statuses).toEqual({
      ses_busy: { kind: "busy", awaitingInput: false, at: 7_000 },
      ses_asking: { kind: "idle", awaitingInput: true, at: 7_000 },
      ses_quiet: { kind: "idle", awaitingInput: false, at: 7_000 },
      ses_background: { kind: "idle", awaitingInput: false, backgroundWork: { agents: 2, shells: 0, other: 0 }, at: 7_000 },
      ses_asleep: undefined,
    })
    expect(fake.reads.filter((read) => read.endsWith("/session/status"))).toEqual([
      `${running.id}/session/status`,
      `${asleep.id}/session/status`,
    ])
  })

  test("inventory exposes canonical project/local context and never includes unsigned shared rows", async () => {
    const ws = await workspace("context")
    await upsertProjectRecord({ id: ws.project_id!, name: "Canonical project" })
    await putSessionMeta("ses_context", { ws, title: "Context", createdAt: 1, updatedAt: 1 })
    const input = { workspace: ws, projectWorkspaces: async () => [], readRuntimeStatus: runtime({}).read }
    const url = `http://daemon/api/claxedo/session-list?scope=workspace&workspaceId=${ws.id}`
    const page = await localSessionListPage({ ...input, query: parseSessionListQuery(new URL(url)) })
    expect(page.items[0]).toMatchObject({ projectName: "Canonical project", placement: { kind: "local", machineName: machineDisplayName(process.platform) }, ownership: "owned" })
    const shared = await localSessionListPage({ ...input, query: parseSessionListQuery(new URL(`${url}&ownership=shared`)) })
    expect(shared.items).toEqual([])
    expect(shared.totalKnown).toEqual(0)
  })
})
