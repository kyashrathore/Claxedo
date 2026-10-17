/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { StartPreview, StartResponse, Task, TaskSessionLinkView } from "@claxedo/tasks"
import { TasksApiError, TasksClientPayloadError } from "@claxedo/tasks/client"
import type { AppError, PlacementId } from "@/server"
import { START_IDLE, startNow, startProgressLine, startProgressTransition, type RootRun, type StartCalls, type StartCopy, type TaskStartProgress } from "./start-run"

const task = { id: "tsk_1", revision: 3, title: "Print the README" } as Task
const READY_PREVIEW = { available: true, attempt: 1, digest: "d", blockers: [], previousTranscriptReadable: false } as unknown as StartPreview
const SESSION = { sessionId: "ses_tasks_1", workspaceId: "ws_root" }
const LINKED: StartResponse = { link: { sessionRef: SESSION } as TaskSessionLinkView, created: true }
const copy: StartCopy = { t: (key) => key, errorMessage: (error: AppError) => `${error.class} copy` }

function deferred<T>() {
  return Promise.withResolvers<T>()
}

function recording(overrides: Partial<StartCalls>) {
  const starts: { readonly digest: string; readonly clientRequestId: string }[] = []
  const opened: string[] = []
  const calls: StartCalls = {
    api: { client: { getTask: async () => ({ task, links: [], attachments: [] }) } as unknown as StartCalls["api"]["client"] },
    preview: async () => READY_PREVIEW,
    start: async (_request, digest, clientRequestId) => {
      starts.push({ digest, clientRequestId })
      return LINKED
    },
    followRoot: async () => ({ kind: "running" }),
    open: async (_taskId, session) => {
      opened.push(session.sessionId)
    },
    ...overrides,
  }
  return { calls, starts, opened }
}

function progressOf() {
  let progress: TaskStartProgress = START_IDLE
  return {
    report: (event: Parameters<typeof startProgressTransition>[1]) => {
      progress = startProgressTransition(progress, event)
    },
    line: () => startProgressLine(progress, task.id, "primary"),
    state: () => progress,
  }
}

const CLOUD = { presetId: "tpr_1", presetRevision: 1, placement: "cloud", slot: "primary" } as const

test("a cloud start says it is starting a workspace while the preview and the Start run, then nothing once it settles", async () => {
  const preview = deferred<StartPreview>()
  const sent = deferred<void>()
  const { calls } = recording({
    preview: () => preview.promise,
    start: async () => {
      await sent.promise
      return LINKED
    },
  })
  const progress = progressOf()
  const started = startNow(calls, copy, task, CLOUD, progress.report)

  await Bun.sleep(0)
  expect(progress.line()).toEqual({ kind: "key", key: "tasks.start.progress.cloud" })
  expect(startProgressLine(progress.state(), "tsk_other", "primary")).toBeUndefined()
  expect(startProgressLine(progress.state(), task.id, "review")).toBeUndefined()

  preview.resolve(READY_PREVIEW)
  await Bun.sleep(0)
  expect(progress.line()).toEqual({ kind: "key", key: "tasks.start.progress.cloud" })

  sent.resolve()
  expect(await started).toEqual({ ok: true })
  expect(progress.line()).toBeUndefined()
})

test("a local start says it is checking the workspace while the preview runs, then the session while the Start runs", async () => {
  const preview = deferred<StartPreview>()
  const sent = deferred<void>()
  const { calls } = recording({
    preview: () => preview.promise,
    start: async () => {
      await sent.promise
      return LINKED
    },
  })
  const progress = progressOf()
  const started = startNow(calls, copy, task, { ...CLOUD, placement: "local" }, progress.report)

  await Bun.sleep(0)
  expect(progress.line()).toEqual({ kind: "key", key: "tasks.start.progress.local" })

  preview.resolve(READY_PREVIEW)
  await Bun.sleep(0)
  expect(progress.line()).toEqual({ kind: "key", key: "tasks.start.progress.session" })

  sent.resolve()
  expect(await started).toEqual({ ok: true })
  expect(progress.line()).toBeUndefined()
})

test("a Start whose root is still starting follows that root's own start, shows its machine, then sends the same Start again and opens the session", async () => {
  const machine = "ws_root" as PlacementId
  const running = deferred<RootRun>()
  const answers: StartResponse[] = [{ preparing: { workspaceId: "ws_root" } }, LINKED]
  const followed: string[] = []
  const { calls, starts, opened } = recording({
    start: async (_request, digest, clientRequestId) => {
      starts.push({ digest, clientRequestId })
      const answer = answers.shift()
      if (!answer) throw new Error("a third Start was sent")
      return answer
    },
    followRoot: async (workspaceId, following) => {
      followed.push(workspaceId)
      following(machine)
      return running.promise
    },
  })
  const progress = progressOf()
  const started = startNow(calls, copy, task, CLOUD, progress.report)

  await Bun.sleep(0)
  expect(followed).toEqual(["ws_root"])
  expect(progress.line()).toEqual({ kind: "machine", placementId: machine })
  expect(starts).toHaveLength(1)
  expect(opened).toEqual([])

  running.resolve({ kind: "running" })
  expect(await started).toEqual({ ok: true })
  expect(starts).toHaveLength(2)
  expect(starts[1]).toEqual(starts[0])
  expect(opened).toEqual([SESSION.sessionId])
  expect(progress.line()).toBeUndefined()
})

test("a root whose start failed ends the Start with that start's reason, and nothing is sent again", async () => {
  const { calls, starts, opened } = recording({
    start: async (_request, digest, clientRequestId) => {
      starts.push({ digest, clientRequestId })
      return { preparing: { workspaceId: "ws_root" } }
    },
    followRoot: async () => ({ kind: "failed", message: "The cloud workspace could not start: the image has no runtime" }),
  })
  const outcome = await startNow(calls, copy, task, CLOUD, progressOf().report)
  expect(outcome).toEqual({ ok: false, message: "The cloud workspace could not start: the image has no runtime" })
  expect(starts).toHaveLength(1)
  expect(opened).toEqual([])
})

test("a root still starting when the same Start is sent again ends the Start rather than following it a second time", async () => {
  let follows = 0
  const { calls, opened } = recording({
    start: async () => ({ preparing: { workspaceId: "ws_root" } }),
    followRoot: async () => {
      follows++
      return { kind: "running" }
    },
  })
  const outcome = await startNow(calls, copy, task, CLOUD, progressOf().report)
  expect(outcome).toEqual({ ok: false, message: "tasks.start.rootStillStarting" })
  expect(follows).toBe(1)
  expect(opened).toEqual([])
})

test("a refused preview ends the start's progress with the refusal", async () => {
  const { calls, starts } = recording({
    preview: async () => ({ ...READY_PREVIEW, available: false, blockers: [{ code: "source_unavailable", detail: "No key" }] }) as unknown as StartPreview,
  })
  const progress = progressOf()
  const outcome = await startNow(calls, copy, task, { ...CLOUD, placement: "local" }, progress.report)
  expect(outcome).toEqual({ ok: false, message: "No key" })
  expect(progress.state()).toEqual(START_IDLE)
  expect(starts).toEqual([])
})

test("a preview the control plane rate-limited says so from the error table, not with the server's words", async () => {
  const { calls } = recording({
    preview: async () => ({ ...READY_PREVIEW, available: false, blockers: [{ code: "rate_limited", detail: "Control Plane request limit exceeded" }] }) as unknown as StartPreview,
  })
  expect(await startNow(calls, copy, task, CLOUD, () => {})).toEqual({ ok: false, message: "rate_limit copy" })
})

test("a Start refused for too many requests says so from the error table", async () => {
  const refusing = (error: Error) => recording({
    start: async () => {
      throw error
    },
  }).calls
  const limited = new TasksApiError(429, "rate_limited", { code: "rate_limited", message: "Control Plane request limit exceeded" })
  expect(await startNow(refusing(limited), copy, task, CLOUD, () => {})).toEqual({ ok: false, message: "rate_limit copy" })
  const guarded = new TasksClientPayloadError(429, "Request failed with status 429")
  expect(await startNow(refusing(guarded), copy, task, CLOUD, () => {})).toEqual({ ok: false, message: "rate_limit copy" })
})
