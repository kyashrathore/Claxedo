import { describe, expect, test } from "bun:test"
import { dispatchPlanOpen, readPlanToolInput } from "./plan-tool"

describe("readPlanToolInput", () => {
  test("titles the plan by its first heading", () => {
    const plan = "Intro line\n\n## Finish steering: transcript placement ##\n\n# Later heading\n"
    expect(readPlanToolInput({ plan, planFilePath: "/home/u/.claude/plans/snappy-puzzling-rainbow.md" })).toEqual({
      markdown: plan,
      title: "Finish steering: transcript placement",
    })
  })

  test("falls back to the plan file's stem when the plan has no heading", () => {
    expect(readPlanToolInput({ plan: "just prose", planFilePath: "C:\\Users\\u\\plans\\cosmic-mixing.md" })).toEqual({
      markdown: "just prose",
      title: "cosmic-mixing",
    })
  })

  test("reads nothing from an empty or missing plan", () => {
    expect(readPlanToolInput({ plan: "  \n" })).toEqual({ markdown: undefined, title: undefined })
    expect(readPlanToolInput(undefined)).toEqual({ markdown: undefined, title: undefined })
  })
})

describe("dispatchPlanOpen", () => {
  const detail = { sessionId: "ses_1", planId: "toolu_1", title: "T", markdown: "# T" }

  test("reports a host that cancelled the event as having opened the plan", () => {
    const root = new EventTarget()
    let received: unknown
    root.addEventListener("claxedo:open-plan", (event) => {
      received = (event as CustomEvent).detail
      event.preventDefault()
    })
    expect(dispatchPlanOpen(root, detail)).toBe(true)
    expect(received).toEqual(detail)
  })

  test("reports an unheard event as not opened", () => {
    expect(dispatchPlanOpen(new EventTarget(), detail)).toBe(false)
    expect(dispatchPlanOpen(null, detail)).toBe(false)
  })
})
