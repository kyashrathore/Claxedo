import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createComposerAutoAccept } from "./auto-accept"

function harness(sessionId?: string) {
  const [active, setActive] = createSignal(false)
  const calls: string[] = []
  const control = createComposerAutoAccept({
    permission: {
      isAutoAccepting: () => active(),
      isAutoAcceptingDirectory: () => active(),
      toggleAutoAccept: (id: string) => {
        calls.push(`session:${id}`)
        setActive((value) => !value)
      },
      toggleAutoAcceptDirectory: (directory: string) => {
        calls.push(`directory:${directory}`)
        setActive((value) => !value)
      },
    },
    sessionId: () => sessionId,
    directory: () => "/work/repo",
  })
  return { active, calls, control }
}

describe("createComposerAutoAccept", () => {
  test("uses the session scope for an existing session", () => {
    createRoot((dispose) => {
      const { active, calls, control } = harness("ses_1")
      control.toggle()
      expect(active()).toBe(true)
      expect(calls).toEqual(["session:ses_1"])
      dispose()
    })
  })

  test("uses the directory scope for a draft", () => {
    createRoot((dispose) => {
      const { active, calls, control } = harness()
      control.toggle()
      expect(active()).toBe(true)
      expect(calls).toEqual(["directory:/work/repo"])
      dispose()
    })
  })
})
