/// <reference types="bun" />
import { expect, test } from "bun:test"
import { backgroundWorkLabel } from "./background-work-label"
import type { TimelineTextKey } from "./model"

const t = (key: TimelineTextKey, params?: Record<string, string | number>) => `${key}(${params?.count ?? ""})`

test("background work label: agents lead, shells and other tasks follow, and nothing running says nothing", () => {
  expect(backgroundWorkLabel({ agents: 0, shells: 0, other: 0 }, t)).toBeUndefined()
  expect(backgroundWorkLabel({ agents: 2, shells: 0, other: 0 }, t)).toBe("session.timeline.backgroundWork.agents.other(2)")
  expect(backgroundWorkLabel({ agents: 1, shells: 1, other: 3 }, t)).toBe(
    "session.timeline.backgroundWork.agents.one(1) · session.timeline.backgroundWork.shells.one(1) · session.timeline.backgroundWork.tasks.other(3)",
  )
  expect(backgroundWorkLabel({ agents: 0, shells: 2, other: 1 }, t)).toBe(
    "session.timeline.backgroundWork.shellsRunning.other(2) · session.timeline.backgroundWork.tasks.one(1)",
  )
  expect(backgroundWorkLabel({ agents: 0, shells: 0, other: 1 }, t)).toBe("session.timeline.backgroundWork.tasksRunning.one(1)")
})
