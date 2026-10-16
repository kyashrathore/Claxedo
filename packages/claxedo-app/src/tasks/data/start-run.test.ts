/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { StartPreview, Task } from "@claxedo/tasks"
import { START_IDLE, startNow, startProgressKey, startProgressTransition, type StartCalls, type TaskStartProgress } from "./start-run"

const task = { id: "tsk_1", revision: 3, title: "Print the README" } as Task

function deferred<T>() {
  return Promise.withResolvers<T>()
}

test("a cloud start says it is starting a workspace while the preview runs, then the session, then nothing once it settles", async () => {
  const preview = deferred<StartPreview>()
  const sent = deferred<void>()
  const calls: StartCalls = {
    api: { client: { getTask: async () => ({ task, links: [], attachments: [] }) } as unknown as StartCalls["api"]["client"] },
    preview: () => preview.promise,
    send: async () => {
      await sent.promise
      return { sessionId: "ses_tasks_1", workspaceId: "ws_root" }
    },
  }
  let progress: TaskStartProgress = START_IDLE
  const seen = () => startProgressKey(progress, task.id, "primary")
  const started = startNow(calls, (key) => key, task, { presetId: "tpr_1", presetRevision: 1, placement: "cloud", slot: "primary" }, (event) => {
    progress = startProgressTransition(progress, event)
  })

  await Bun.sleep(0)
  expect(seen()).toBe("tasks.start.progress.cloud")
  expect(startProgressKey(progress, "tsk_other", "primary")).toBeUndefined()
  expect(startProgressKey(progress, task.id, "review")).toBeUndefined()

  preview.resolve({ available: true, attempt: 1, digest: "d", blockers: [], previousTranscriptReadable: false } as unknown as StartPreview)
  await Bun.sleep(0)
  expect(seen()).toBe("tasks.start.progress.session")

  sent.resolve()
  expect(await started).toEqual({ ok: true })
  expect(seen()).toBeUndefined()
})

test("a refused preview ends the start's progress with the refusal", async () => {
  const calls: StartCalls = {
    api: { client: { getTask: async () => ({ task, links: [], attachments: [] }) } as unknown as StartCalls["api"]["client"] },
    preview: async () => ({ available: false, attempt: 1, digest: "d", blockers: [{ code: "source_unavailable", detail: "No key" }], previousTranscriptReadable: false }) as unknown as StartPreview,
    send: async () => ({ sessionId: "ses", workspaceId: "ws" }),
  }
  let progress: TaskStartProgress = START_IDLE
  const outcome = await startNow(calls, (key) => key, task, { presetId: "tpr_1", presetRevision: 1, placement: "local", slot: "primary" }, (event) => {
    progress = startProgressTransition(progress, event)
  })
  expect(outcome).toEqual({ ok: false, message: "No key" })
  expect(progress).toEqual(START_IDLE)
})
