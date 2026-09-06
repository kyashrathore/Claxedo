import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createComposerAutoAccept } from "./auto-accept"

function harness(sessionId?: string) {
  const [sessionActive, setSessionActive] = createSignal(!sessionId)
  const [directoryActive, setDirectoryActive] = createSignal(!!sessionId)
  const calls: unknown[][] = []
  const control = createComposerAutoAccept({
    permission: {
      isAutoAccepting: (id: string, directory: string) => {
        calls.push(["read-session", id, directory])
        return sessionActive()
      },
      isAutoAcceptingDirectory: (directory: string) => {
        calls.push(["read-directory", directory])
        return directoryActive()
      },
      toggleAutoAccept: (id: string, directory: string) => {
        calls.push(["session", id, directory])
        setSessionActive((value) => !value)
      },
      toggleAutoAcceptDirectory: (directory: string) => {
        calls.push(["directory", directory])
        setDirectoryActive((value) => !value)
      },
    },
    sessionId: () => sessionId,
    directory: () => "/work/repo",
  })
  return { calls, control }
}

describe("createComposerAutoAccept", () => {
  test("uses the session scope for an existing session", () => {
    createRoot((dispose) => {
      const { calls, control } = harness("ses_1")
      expect(control.active()).toBe(false)
      expect(control.currentlyActive()).toBe(false)
      expect(calls.every((call) => call[0] === "read-session")).toBe(true)
      expect(calls).toContainEqual(["read-session", "ses_1", "/work/repo"])
      control.toggle()
      expect(control.active()).toBe(true)
      expect(control.currentlyActive()).toBe(true)
      expect(calls.filter((call) => !String(call[0]).startsWith("read-"))).toEqual([["session", "ses_1", "/work/repo"]])
      dispose()
    })
  })

  test("uses the directory scope for a draft", () => {
    createRoot((dispose) => {
      const { calls, control } = harness()
      expect(control.active()).toBe(false)
      expect(control.currentlyActive()).toBe(false)
      expect(calls.every((call) => call[0] === "read-directory")).toBe(true)
      expect(calls).toContainEqual(["read-directory", "/work/repo"])
      control.toggle()
      expect(control.active()).toBe(true)
      expect(control.currentlyActive()).toBe(true)
      expect(calls.filter((call) => !String(call[0]).startsWith("read-"))).toEqual([["directory", "/work/repo"]])
      dispose()
    })
  })
})
