/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test"
import { QueryClient, type InfiniteData } from "@tanstack/solid-query"
import type { Page, Task, TaskSummary, TasksCommand } from "@claxedo/tasks"
import { createRoot } from "solid-js"
import { placementId, projectId, sessionId } from "./ids"
import { createTasksApi } from "./tasks"
import { createTransport, type Transport } from "./transport"
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
  const api = createTasksApi(serving(task("tsk_child", "tsk_parent")), queryClient, workspacesOf(queryClient))
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
  const api = createTasksApi(serving(task("tsk_child", "tsk_parent")), queryClient, workspacesOf(queryClient))
  const listed = { ...(({ description: _description, ...rest }) => rest)(task("tsk_child", "tsk_parent")), hasDescription: false, links: { count: 0 }, children: { total: 0, done: 0 } }
  queryClient.setQueryData<Children>(api.keys.children("tsk_parent"), { pages: [{ items: [listed], nextCursor: null }], pageParams: [undefined] })

  await api.command({ clientRequestId: "req_1", command: createChild("tsk_parent") })
  expect(queryClient.getQueryData<Children>(api.keys.children("tsk_parent"))?.pages[0]?.items).toHaveLength(1)

  const fresh = new QueryClient()
  const unread = createTasksApi(serving(task("tsk_other", "tsk_unread")), fresh, workspacesOf(fresh))
  await unread.command({ clientRequestId: "req_2", command: createChild("tsk_unread") })
  expect(fresh.getQueryData(unread.keys.children("tsk_unread"))).toBeUndefined()
})

function cloudCatalog(workspaceIds: () => readonly string[], reads: string[]): Transport {
  return {
    serverUrl: "http://127.0.0.1:1",
    loopback: false,
    json: async (path: string) => {
      reads.push(path)
      const rows = Object.fromEntries(workspaceIds().map((id) => [id, { id, backing: "cloud-vm", workspace_name: id, directory: `workspace:${id}`, status: "ready", reachable: true }]))
      return { deployment: { serverKind: "daemon", issuesSessions: true }, project: [{ id: "prj", worktree: "prj", workspaces: rows }] }
    },
    onSessionHost: () => () => undefined,
  } as Pick<Transport, "serverUrl" | "loopback" | "json" | "onSessionHost"> as Transport
}

function workspacesOf(queryClient: QueryClient) {
  return createWorkspaces(cloudCatalog(() => [], []), queryClient)
}

test("a task session in a workspace the catalog has not read yet is located only once the catalog has read it, so its route can open", async () => {
  await createRoot(async (dispose) => {
    const created = ["ws_known"]
    const reads: string[] = []
    const catalog = cloudCatalog(() => created, reads)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const workspaces = createWorkspaces(catalog, queryClient)
    await workspaces.load()
    const api = createTasksApi(catalog, queryClient, workspaces)
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
