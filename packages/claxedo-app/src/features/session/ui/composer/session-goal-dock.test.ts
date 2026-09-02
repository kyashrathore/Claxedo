import { describe, expect, test } from "bun:test"
import { sessionGoalControls } from "./session-goal-dock"

describe("session Goal controls", () => {
  const available = { implemented: true, available: true }

  test("shows pause and resume only as a complete supported pair", () => {
    expect(sessionGoalControls({ goal: { status: "active" }, capabilities: { ...available, actions: ["pause"] } })).toEqual({
      pause: false,
      resume: false,
      delete: false,
    })
    expect(sessionGoalControls({ goal: { status: "active" }, capabilities: { ...available, actions: ["pause", "resume"] } })).toEqual({
      pause: true,
      resume: false,
      delete: false,
    })
    expect(sessionGoalControls({ goal: { status: "paused" }, capabilities: { ...available, actions: ["pause", "resume"] } })).toEqual({
      pause: false,
      resume: true,
      delete: false,
    })
  })

  test("shows delete only when the harness advertises it", () => {
    expect(sessionGoalControls({ goal: { status: "complete" }, capabilities: { ...available, actions: ["delete"] } })).toEqual({
      pause: false,
      resume: false,
      delete: true,
    })
  })

  test("hides every action while the harness is unavailable", () => {
    expect(sessionGoalControls({
      goal: { status: "active" },
      capabilities: { implemented: true, available: false, actions: ["pause", "resume", "delete"] },
    })).toEqual({ pause: false, resume: false, delete: false })
  })
})
