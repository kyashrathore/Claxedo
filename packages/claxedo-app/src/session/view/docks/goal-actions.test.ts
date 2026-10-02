import { expect, test } from "bun:test"
import { sessionControls } from "@/access/model"
import { goalActions, goalControls, type GoalSnapshot } from "./model"

const active: GoalSnapshot = { status: "active", objective: "Ship it" }
const offered = ["pause", "resume", "remove"] as const

test("the goal dock offers its controls to the session's owner and to no share holder", () => {
  const controlled: string[] = []
  const control = async (action: string) => void controlled.push(action)
  const owned = goalActions(offered, control, sessionControls(undefined))
  expect(goalControls(active, owned)).toEqual({ pause: true, resume: false, remove: true })
  void owned.pause?.()
  expect(controlled).toEqual(["pause"])
  for (const share of ["send", "follow"] as const) {
    expect(goalControls(active, goalActions(offered, control, sessionControls(share)))).toEqual({ pause: false, resume: false, remove: false })
  }
})
