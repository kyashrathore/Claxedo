import { expect, test } from "bun:test"
import { mergeSubagent } from "./subagent-merge"

test("only an admitted new run reopens a terminal child; older results cannot finish the new run", () => {
  const completed = mergeSubagent(undefined, { subagentKey: "child", revision: 3, status: "completed" })
  expect(mergeSubagent(completed, { subagentKey: "child", revision: 4, status: "running" }).status).toBe("completed")
  const running = mergeSubagent(completed, { subagentKey: "child", revision: 5, status: "running", runRevision: 5 })
  expect(running.status).toBe("running")
  expect(mergeSubagent(running, { subagentKey: "child", revision: 3, status: "completed" }).status).toBe("running")
  expect(mergeSubagent(running, { subagentKey: "child", revision: 6, status: "completed", runRevision: 2 }).status).toBe("running")
  const finished = mergeSubagent(running, { subagentKey: "child", revision: 6, status: "failed" })
  expect(finished.status).toBe("failed")
  expect(mergeSubagent(finished, { subagentKey: "child", revision: 5, status: "running", runRevision: 5 }).status).toBe("failed")
})
