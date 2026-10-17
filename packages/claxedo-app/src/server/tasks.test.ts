/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test"
import { QueryClient, type InfiniteData } from "@tanstack/solid-query"
import type { Page, Task, TaskSummary, TasksCommand } from "@claxedo/tasks"
import { createRoot } from "solid-js"
import { placementId, projectId, sessionId } from "./ids"
import type { WorkspaceStartProgress } from "./cloud-types"
import type { ServerEvent } from "./events"
import { createTasksApi } from "./tasks"
import { createTransport, type Transport } from "./transport"
import type { StartOptions } from "./workspace-start"
import { createWorkspaceWakes, type WorkspaceWakes } from "./workspace-wakes"
import { createWorkspaces } from "./workspaces"

const running: Array<{ stop: (force: boolean) => unknown }> = []

afterEach(() => {
  for (const server of running.splice(0)) server.stop(true)
})

function task(id: string, parentTaskId: string | null): Task {
  return {
    id,
    revision: 1,
    scopeId: "org",
    projectId: "prj",
    number: 1,
    childNumber: parentTaskId ? 1 : null,
    workspaceId: null,
    parentTaskId,
    createdFrom: null,
    title: `Task ${id}`,
    description: "",
    status: "todo",
    childSetRevision: 0,
    archivedAt: null,
    createdAt: 10,
    updatedAt: 10,
  }
}

function serving(created: Task) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ result: { type: "task.create", task: created, parent: null }, replayed: false }),
  })
  running.push(server)
  return createTransport({ serverUrl: `http://127.0.0.1:${server.port}` })
}

type Children = InfiniteData<Page<TaskSummary>, string | undefined>

const createChild = (parentTaskId: string): TasksCommand => ({
  type: "task.create",
  input: { projectId: "prj", title: "Subtask", description: "", workspaceId: null, parentTaskId },
})

test("a created subtask is in its parent's children from the create's own answer, before any read", async () => {
  const queryClient = new QueryClient()
  const api = createTasksApi(serving(task("tsk_child", "tsk_parent")), queryClient, workspacesOf(queryClient), NO_WAKES)
  queryClient.setQueryData<Children>(api.keys.children("tsk_parent"), { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] })

  const created = await api.command({ clientRequestId: "req_1", command: createChild("tsk_parent") })

  expect(created.result).toMatchObject({ type: "task.create", task: { id: "tsk_child" } })
  const children = queryClient.getQueryData<Children>(api.keys.children("tsk_parent"))
  expect(children?.pages[0]?.items).toEqual([
    { ...(({ description: _description, ...rest }) => rest)(task("tsk_child", "tsk_parent")), hasDescription: false, links: { count: 0 }, children: { total: 0, done: 0 } },
  ])
})

test("a replayed create does not list its subtask twice, and a parent nobody has read stays unread", async () => {
  const queryClient = new QueryClient()
  const api = createTasksApi(serving(task("tsk_child", "tsk_parent")), queryClient, workspacesOf(queryClient), NO_WAKES)
  const listed = { ...(({ description: _description, ...rest }) => rest)(task("tsk_child", "tsk_parent")), hasDescription: false, links: { count: 0 }, children: { total: 0, done: 0 } }
  queryClient.setQueryData<Children>(api.keys.children("tsk_parent"), { pages: [{ items: [listed], nextCursor: null }], pageParams: [undefined] })

  await api.command({ clientRequestId: "req_1", command: createChild("tsk_parent") })
  expect(queryClient.getQueryData<Children>(api.keys.children("tsk_parent"))?.pages[0]?.items).toHaveLength(1)

  const fresh = new QueryClient()
  const unread = createTasksApi(serving(task("tsk_other", "tsk_unread")), fresh, workspacesOf(fresh), NO_WAKES)
  await unread.command({ clientRequestId: "req_2", command: createChild("tsk_unread") })
  expect(fresh.getQueryData(unread.keys.children("tsk_unread"))).toBeUndefined()
})

type RootFollow = { readonly options: StartOptions | undefined; readonly resolve: () => void; readonly reject: (error: unknown) => void }

function cloudCatalog(workspaceIds: () => readonly string[], reads: string[], status: (id: string) => string = () => "ready", follows: RootFollow[] = []): Transport {
  return {
    serverUrl: "http://127.0.0.1:1",
    loopback: false,
    json: async (path: string) => {
      reads.push(path)
      const rows = Object.fromEntries(workspaceIds().map((id) => [id, {
        id, backing: "cloud-vm", workspace_name: id, directory: `workspace:${id}`, status: status(id), reachable: status(id) === "ready",
        ...(status(id) === "failed" ? { error: "The cloud workspace could not start: the image has no runtime" } : {}),
      }]))
      return { deployment: { serverKind: "daemon", issuesSessions: true }, project: [{ id: "prj", worktree: "prj", workspaces: rows }] }
    },
    onSessionHost: () => () => undefined,
    onRuntimeImage: () => () => undefined,
    followRuntime: (_workspaceId: string, options?: StartOptions) =>
      new Promise<void>((resolve, reject) => follows.push({ options, resolve, reject })),
  } as Pick<Transport, "serverUrl" | "loopback" | "json" | "onSessionHost" | "onRuntimeImage" | "followRuntime"> as Transport
}

function workspacesOf(queryClient: QueryClient) {
  return createWorkspaces(cloudCatalog(() => [], []), queryClient)
}

const NO_WAKES: Pick<WorkspaceWakes, "follow" | "runtime"> = {
  follow: async () => {
    throw new Error("this case follows no root")
  },
  runtime: () => ({ kind: "live" }),
}

const noEvents = (_listener: (event: ServerEvent) => void) => () => undefined

test("a task root the Start left starting is followed through its own start's steps from a catalog read after the Start, and reads running once the server is done", async () => {
  await createRoot(async (dispose) => {
    const created: string[] = []
    const reads: string[] = []
    const follows: RootFollow[] = []
    const status = { value: "provisioning" }
    const catalog = cloudCatalog(() => created, reads, () => status.value, follows)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const workspaces = createWorkspaces(catalog, queryClient)
    await workspaces.load()
    const wakes = createWorkspaceWakes(catalog, workspaces, noEvents)
    const api = createTasksApi(catalog, queryClient, workspaces, wakes)
    created.push("ws_task_root")
    const root = placementId("ws_task_root")
    const followed: string[] = []

    const run = api.followRoot("ws_task_root", (id) => followed.push(id))
    for (let tick = 0; tick < 20 && follows.length === 0; tick += 1) await Bun.sleep(0)
    expect(followed).toEqual([root])
    expect(follows).toHaveLength(1)
    const machine: WorkspaceStartProgress = { kind: "provisioning", bootMode: "cold-start", steps: { done: ["machine"], startedAt: 1, stepStartedAt: 2 } }
    follows[0]?.options?.onProgress?.(machine)
    expect(JSON.parse(JSON.stringify(wakes.runtime(root)))).toEqual({ kind: "waking", bootMode: "cold-start", steps: { done: ["machine"], startedAt: 1, stepStartedAt: 2 }, followed: true })

    status.value = "ready"
    follows[0]?.resolve()
    expect(await run).toEqual({ kind: "running" })
    expect(wakes.runtime(root)).toEqual({ kind: "live" })
    workspaces.dispose()
    dispose()
  })
})

test("a task root whose start the server failed reads not running, with the server's reason", async () => {
  await createRoot(async (dispose) => {
    const created = ["ws_task_root"]
    const follows: RootFollow[] = []
    const status = { value: "provisioning" }
    const catalog = cloudCatalog(() => created, [], () => status.value, follows)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const workspaces = createWorkspaces(catalog, queryClient)
    const wakes = createWorkspaceWakes(catalog, workspaces, noEvents)
    const api = createTasksApi(catalog, queryClient, workspaces, wakes)

    const run = api.followRoot("ws_task_root", () => undefined)
    for (let tick = 0; tick < 20 && follows.length === 0; tick += 1) await Bun.sleep(0)
    status.value = "failed"
    follows[0]?.resolve()
    const answered = await run
    expect(answered.kind).toBe("notRunning")
    expect(answered.kind === "notRunning" ? answered.error?.message : undefined).toBe("The cloud workspace could not start: the image has no runtime")
    workspaces.dispose()
    dispose()
  })
})

test("a task session in a workspace the catalog has not read yet is located only once the catalog has read it, so its route can open", async () => {
  await createRoot(async (dispose) => {
    const created = ["ws_known"]
    const reads: string[] = []
    const catalog = cloudCatalog(() => created, reads)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const workspaces = createWorkspaces(catalog, queryClient)
    await workspaces.load()
    const api = createTasksApi(catalog, queryClient, workspaces, NO_WAKES)
    created.push("ws_task_root")

    const located = await api.locateSession({ workspaceId: "ws_task_root", sessionId: "ses_tasks_1" })

    expect(located).toEqual({ placementId: placementId("ws_task_root"), sessionId: sessionId("ses_tasks_1") })
    expect(workspaces.byId(placementId("ws_task_root"))?.projectId).toBe(projectId("prj"))
    const rereads = reads.length
    await api.locateSession({ workspaceId: "ws_known", sessionId: "ses_other" })
    expect(reads.length).toBe(rereads)
    workspaces.dispose()
    dispose()
  })
})
