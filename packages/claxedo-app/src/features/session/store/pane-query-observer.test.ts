import { expect, test } from "bun:test"
import { parkedPaneQueryOptions } from "./pane-query-observer"

test("parked pane observers use tagged lifecycle state rather than a resource identity", () => {
  const options = parkedPaneQueryOptions("session-status", "inactive")

  expect(options.queryKey).toEqual([
    "shell",
    "pane-observer",
    { state: "parked", reason: "inactive" },
    "session-status",
  ])
  expect(options.enabled).toBe(false)
})
