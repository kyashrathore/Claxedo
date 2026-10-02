import { expect, test } from "bun:test"
import type { SessionControls } from "@/access"
import { goalActions, goalControls, type GoalSnapshot } from "./model"

const active: GoalSnapshot = { status: "active", objective: "Ship it" }
const offered = ["pause", "resume", "remove"] as const
const owner: SessionControls = { owner: true, send: true }
const sendShare: SessionControls = { owner: false, send: true }
const followShare: SessionControls = { owner: false, send: false }

test("the goal dock offers its controls to the session's owner and to no share holder", () => {
  const controlled: string[] = []
  const control = async (action: string) => void controlled.push(action)
  const owned = goalActions(offered, control, owner)
  expect(goalControls(active, owned)).toEqual({ pause: true, resume: false, remove: true })
  void owned.pause?.()
  expect(controlled).toEqual(["pause"])
  for (const share of [sendShare, followShare]) {
    expect(goalControls(active, goalActions(offered, control, share))).toEqual({ pause: false, resume: false, remove: false })
  }
})
