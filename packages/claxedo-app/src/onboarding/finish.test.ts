/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { placementId, projectId, type Project } from "@/server"
import { createFinish, type FinishSteps } from "./finish"
import { openable, type Created, type Openable } from "./model"

const project = { id: projectId("prj_1"), name: "widgets" } as Pick<Project, "id" | "name"> as Project

function world(plan: ReadonlyArray<Created | Error>, openFailures: readonly Error[]) {
  const creates: Array<Created | undefined> = []
  const opens: Openable[] = []
  const failures = [...openFailures]
  const steps: FinishSteps = {
    create: async (created) => {
      creates.push(created)
      const next = plan[creates.length - 1] ?? new Error("Nothing left to create")
      if (next instanceof Error) throw next
      return next
    },
    open: async (created) => {
      opens.push(created)
      const failure = failures.shift()
      if (failure) throw failure
    },
    describe: (error, created) => `${openable(created) ? "created, not opened" : "not created"}: ${error instanceof Error ? error.message : String(error)}`,
  }
  return createRoot((dispose) => ({ finish: createFinish(steps), creates, opens, dispose }))
}

test("a creation whose open fails is opened on the next click, never created again, and Finish then stays done", async () => {
  const { finish, creates, opens, dispose } = world([{ kind: "project", project }], [new Error("Inventory unavailable")])
  await finish.run()
  expect(finish.failure()).toBe("created, not opened: Inventory unavailable")
  expect(finish.created()).toEqual({ kind: "project", project })
  finish.moved()
  expect(finish.created()).toEqual({ kind: "project", project })
  await finish.run()
  expect(creates).toEqual([undefined])
  expect(opens).toEqual([{ kind: "project", project }, { kind: "project", project }])
  expect(finish.finished()).toBe(true)
  expect(finish.failure()).toBeUndefined()
  await finish.run()
  expect([creates.length, opens.length]).toEqual([1, 2])
  dispose()
})

test("a creation that fails before anything exists stays retryable and a move clears its failure", async () => {
  const { finish, creates, opens, dispose } = world([new Error("Workspace creation refused")], [])
  await finish.run()
  expect(finish.failure()).toBe("not created: Workspace creation refused")
  expect(finish.created()).toBeUndefined()
  finish.moved()
  expect([finish.failure(), finish.working(), finish.finished()]).toEqual([undefined, false, false])
  expect([creates, opens]).toEqual([[undefined], []])
  dispose()
})

test("a hosted project whose workspace create failed is kept, so the retry creates only the workspace", async () => {
  const workspace: Created = { kind: "workspace", placementId: placementId("ws_1") }
  const { finish, creates, opens, dispose } = world([{ kind: "cloudProject", project }, new Error("No cloud sandbox driver"), workspace], [])
  await finish.run()
  expect(finish.failure()).toBe("not created: No cloud sandbox driver")
  expect(finish.created()).toEqual({ kind: "cloudProject", project })
  finish.moved()
  expect(finish.created()).toEqual({ kind: "cloudProject", project })
  await finish.run()
  expect(creates).toEqual([undefined, { kind: "cloudProject", project }, { kind: "cloudProject", project }])
  expect(opens).toEqual([workspace])
  expect(finish.finished()).toBe(true)
  expect(finish.created()).toEqual(workspace)
  dispose()
})
