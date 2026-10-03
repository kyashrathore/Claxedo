/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { placementId, projectId, type Project } from "@/server"
import { createFinish, type FinishSteps } from "./finish"
import type { Created } from "./model"

const project = { id: projectId("prj_1"), name: "widgets" } as Pick<Project, "id" | "name"> as Project

function world(plan: ReadonlyArray<Created | Error>, openFailures: readonly Error[]) {
  let creates = 0
  const opens: Created[] = []
  const failures = [...openFailures]
  const steps: FinishSteps = {
    create: async () => {
      creates += 1
      const next = plan[creates - 1] ?? new Error("Nothing left to create")
      if (next instanceof Error) throw next
      return next
    },
    open: async (created) => {
      opens.push(created)
      const failure = failures.shift()
      if (failure) throw failure
    },
    describe: (error, created) => `${created ? "created, not opened" : "not created"}: ${error instanceof Error ? error.message : String(error)}`,
  }
  return createRoot((dispose) => ({ finish: createFinish(steps), creates: () => creates, opens, dispose }))
}

test("a creation whose open fails is opened on the next click, never created again, and Finish then stays done", async () => {
  const { finish, creates, opens, dispose } = world([{ kind: "project", project }], [new Error("Inventory unavailable")])
  await finish.run()
  expect(finish.failure()).toBe("created, not opened: Inventory unavailable")
  expect(finish.created()).toEqual({ kind: "project", project })
  finish.moved()
  expect(finish.created()).toEqual({ kind: "project", project })
  await finish.run()
  expect(creates()).toBe(1)
  expect(opens).toEqual([{ kind: "project", project }, { kind: "project", project }])
  expect(finish.finished()).toBe(true)
  expect(finish.failure()).toBeUndefined()
  await finish.run()
  expect([creates(), opens.length]).toEqual([1, 2])
  dispose()
})

test("a creation that fails before anything exists stays retryable and a move clears its failure", async () => {
  const { finish, creates, opens, dispose } = world([new Error("Workspace creation refused")], [])
  await finish.run()
  expect(finish.failure()).toBe("not created: Workspace creation refused")
  expect(finish.created()).toBeUndefined()
  finish.moved()
  expect([finish.failure(), finish.working(), finish.finished()]).toEqual([undefined, false, false])
  expect([creates(), opens]).toEqual([1, []])
  dispose()
})

test("a workspace create that failed creates again on the next click, then stays created", async () => {
  const workspace: Created = { kind: "workspace", placementId: placementId("ws_1") }
  const { finish, creates, opens, dispose } = world([new Error("No cloud sandbox driver"), workspace], [])
  await finish.run()
  expect(finish.failure()).toBe("not created: No cloud sandbox driver")
  expect(finish.created()).toBeUndefined()
  await finish.run()
  expect(creates()).toBe(2)
  expect(opens).toEqual([workspace])
  expect(finish.finished()).toBe(true)
  expect(finish.created()).toEqual(workspace)
  dispose()
})
