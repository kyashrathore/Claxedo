import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const runtimes = vi.hoisted(() => ({ failing: new Set<string>() }))

vi.mock("../../deployments/local/embedded-workspace-runtime", () => ({
  ensureEmbeddedWorkspaceRuntime: async (ws: { id: string }) => ({
    app: new Hono()
      .get("/session/status", (c) =>
        runtimes.failing.has(ws.id) ? c.json({ error: { code: "engine_down", workspaceId: ws.id } }, 500) : c.json({ [`ses_${ws.id}`]: { type: "busy" } }))
      .get("/permission", (c) => c.json([{ id: `per_${ws.id}`, sessionID: `ses_${ws.id}` }]))
      .get("/question", (c) => c.json([])),
  }),
}))

const [{ createWorkspaceRuntimeProxy }, { ClaxedoDB }, { ensureWorkspace }] = await Promise.all([
  import("./middleware"),
  import("@claxedo/server-core/platform/db/index"),
  import("@claxedo/server-core/workspace/store/index"),
])

const member = { actorId: "usr_member", actorKind: "human", actorPublicId: "member", actorName: "Member", orgId: "org_member", role: "editor" } as const
const relayed = { authorization: "Bearer rht", "x-forwarded-by": "workspace-relay" }

type Activity = {
  workspaces: { workspaceId: string; status: Record<string, unknown>; permissions: { id: string }[]; questions: unknown[] }[]
  failures: { workspaceId: string; status: number; error: string }[]
}

describe("one session-activity read across workspaces", () => {
  const previousDataDir = process.env.CLAXEDO_DATA_DIR
  let dataRoot: string
  const ids: { mine: string; theirs: string } = { mine: "", theirs: "" }

  async function repository(name: string) {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(dataRoot, `${name}-`)))
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory, stdio: "ignore" })
    return (await ensureWorkspace({ kind: "local", directory }))!.id
  }

  beforeAll(async () => {
    dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-dispatch-activity-"))
    process.env.CLAXEDO_DATA_DIR = dataRoot
    ids.mine = await repository("mine")
    ids.theirs = await repository("theirs")
  })

  afterAll(async () => {
    ClaxedoDB.close()
    if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = previousDataDir
    await fs.rm(dataRoot, { recursive: true, force: true })
  })

  function dispatcher(options: Parameters<typeof createWorkspaceRuntimeProxy>[0] = {}) {
    return new Hono().use(createWorkspaceRuntimeProxy(options)).all("*", (c) => c.text("fell through", 404))
  }

  async function read(app: Hono, url = "http://127.0.0.1/api/wr/session-activity", headers: Record<string, string> = {}) {
    const response = await app.request(url, { headers })
    return { status: response.status, text: await response.text() }
  }

  test("the machine's own user reads every workspace's statuses, permissions and questions at once", async () => {
    const { status, text } = await read(dispatcher({ verifyRelayIngress: true }))
    expect(status).toBe(200)
    const body = JSON.parse(text) as Activity
    expect(body.workspaces.map((item) => item.workspaceId).sort()).toEqual([ids.mine, ids.theirs].sort())
    const mine = body.workspaces.find((item) => item.workspaceId === ids.mine)!
    expect(mine.status).toEqual({ [`ses_${ids.mine}`]: { type: "busy" } })
    expect(mine.permissions.map((item) => item.id)).toEqual([`per_${ids.mine}`])
    expect(mine.questions).toEqual([])
    expect(body.failures).toEqual([])
  })

  test("a relayed member with access to one workspace reads only that one, and the other is named nowhere", async () => {
    runtimes.failing.add(ids.theirs)
    try {
      const resolveRelayActor = async (_request: Request, workspaceId: string) => (workspaceId === ids.mine ? member : undefined)
      for (const options of [{ requireRelayActor: true, resolveRelayActor }, { verifyRelayIngress: true, resolveRelayActor }]) {
        const { status, text } = await read(dispatcher(options), undefined, relayed)
        expect(status).toBe(200)
        expect(JSON.parse(text)).toEqual({
          workspaces: [{ workspaceId: ids.mine, status: { [`ses_${ids.mine}`]: { type: "busy" } }, permissions: [{ id: `per_${ids.mine}`, sessionID: `ses_${ids.mine}` }], questions: [] }],
          failures: [],
        })
        expect(text).not.toContain(ids.theirs)
      }
    } finally {
      runtimes.failing.delete(ids.theirs)
    }
  })

  test("a workspace whose access question cannot be answered is named nowhere", async () => {
    const app = dispatcher({
      requireRelayActor: true,
      resolveRelayActor: async (_request, workspaceId) => {
        if (workspaceId === ids.mine) return member
        throw new Error(`authority unavailable for ${workspaceId}`)
      },
    })
    const { status, text } = await read(app, undefined, relayed)
    expect(status).toBe(200)
    expect((JSON.parse(text) as Activity).workspaces.map((item) => item.workspaceId)).toEqual([ids.mine])
    expect(text).not.toContain(ids.theirs)
  })

  test("a caller that is not the machine's own user reads nothing", async () => {
    for (const [url, headers] of [
      ["http://192.168.1.20/api/wr/session-activity", {}],
      ["http://127.0.0.1/api/wr/session-activity", { "x-forwarded-by": "workspace-relay" }],
    ] as const) {
      const { status, text } = await read(dispatcher({ verifyRelayIngress: true }), url, headers)
      expect(status).toBe(200)
      expect(JSON.parse(text)).toEqual({ workspaces: [], failures: [] })
    }
  })

  test("a workspace whose runtime fails is reported by id beside the ones that answered", async () => {
    runtimes.failing.add(ids.theirs)
    try {
      const body = JSON.parse((await read(dispatcher())).text) as Activity
      expect(body.workspaces.map((item) => item.workspaceId)).toEqual([ids.mine])
      expect(body.failures).toEqual([{ workspaceId: ids.theirs, status: 500, error: JSON.stringify({ error: { code: "engine_down", workspaceId: ids.theirs } }) }])
    } finally {
      runtimes.failing.delete(ids.theirs)
    }
  })

  test("naming a workspace keeps the request on that workspace's own dispatch", async () => {
    const { status } = await read(dispatcher(), `http://127.0.0.1/api/wr/session-activity?workspaceId=${ids.mine}`)
    expect(status).toBe(404)
  })
})
