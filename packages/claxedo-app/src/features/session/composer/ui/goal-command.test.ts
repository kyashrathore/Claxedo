import { describe, expect, test } from "bun:test"
import { resolveGoalComposerIntent } from "./goal-command"

describe("Goal composer intent", () => {
  test("bare /goal arms without an objective", () => {
    expect(resolveGoalComposerIntent({ text: " /goal ", armed: false, mode: "normal" })).toEqual({ kind: "arm" })
  })

  test("/goal objective and an armed draft converge on the same objective", () => {
    expect(resolveGoalComposerIntent({ text: "/goal Ship when checks pass", armed: false, mode: "normal" })).toEqual({
      kind: "submit",
      objective: "Ship when checks pass",
    })
    expect(resolveGoalComposerIntent({ text: "Ship when checks pass", armed: true, mode: "normal" })).toEqual({
      kind: "submit",
      objective: "Ship when checks pass",
    })
  })

  test("does not intercept shell input or goal-like custom commands", () => {
    expect(resolveGoalComposerIntent({ text: "/goal ship", armed: true, mode: "shell" })).toEqual({ kind: "none" })
    expect(resolveGoalComposerIntent({ text: "/goalkeeper ship", armed: false, mode: "normal" })).toEqual({ kind: "none" })
  })
})
