/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test"
import { QueryClient, type InfiniteData } from "@tanstack/solid-query"
import type { Page, Task, TaskSummary, TasksCommand } from "@claxedo/tasks"
import { createTasksApi } from "./tasks"
import { createTransport } from "./transport"

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
  const api = createTasksApi(serving(task("tsk_child", "tsk_parent")), queryClient)
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
  const api = createTasksApi(serving(task("tsk_child", "tsk_parent")), queryClient)
  const listed = { ...(({ description: _description, ...rest }) => rest)(task("tsk_child", "tsk_parent")), hasDescription: false, links: { count: 0 }, children: { total: 0, done: 0 } }
  queryClient.setQueryData<Children>(api.keys.children("tsk_parent"), { pages: [{ items: [listed], nextCursor: null }], pageParams: [undefined] })

  await api.command({ clientRequestId: "req_1", command: createChild("tsk_parent") })
  expect(queryClient.getQueryData<Children>(api.keys.children("tsk_parent"))?.pages[0]?.items).toHaveLength(1)

  const fresh = new QueryClient()
  const unread = createTasksApi(serving(task("tsk_other", "tsk_unread")), fresh)
  await unread.command({ clientRequestId: "req_2", command: createChild("tsk_unread") })
  expect(fresh.getQueryData(unread.keys.children("tsk_unread"))).toBeUndefined()
})
