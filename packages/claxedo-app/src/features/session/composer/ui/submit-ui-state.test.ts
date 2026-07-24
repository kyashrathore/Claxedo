import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { Prompt } from "@/features/session/providers/prompt"
import { createPromptInputBootState, createPromptInputSubmitRetry } from "./submit-ui-state"

describe("prompt input submit UI state", () => {
  test("boot state formats labels and clears once work starts", async () => {
    await createRoot(async (dispose) => {
      const [working, setWorking] = createSignal(false)
      const boot = createPromptInputBootState({
        working,
        canAbort: () => true,
      })

      boot.setBoot({ harness: "Claude" })
      expect(boot.booting()).toBe(true)
      expect(boot.busy()).toBe(true)
      expect(boot.bootText()).toBe("Booting Claude...")

      boot.setBoot({ harness: "Claude", phase: "sending" })
      expect(boot.bootText()).toBe("Sending first message...")

      setWorking(true)
      await Promise.resolve()
      expect(boot.booting()).toBe(false)
      expect(boot.stoppable()).toBe(true)
      dispose()
    })
  })

  test("submit retry captures a non-empty prompt and restores it before resubmitting", async () => {
    await createRoot(async (dispose) => {
      let promptValue: Prompt = [{ type: "text", content: "first", start: 0, end: 5 }]
      let mode: "normal" | "shell" = "shell"
      let rawCalls = 0
      let registeredRetry: (() => void) | undefined
      const rawPrompts: Prompt[] = []
      const rawModes: Array<"normal" | "shell"> = []
      const retry = createPromptInputSubmitRetry({
        resetKey: () => "scope-a",
        rawHandleSubmit: () => {
          rawCalls++
          rawPrompts.push(promptValue)
          rawModes.push(mode)
          promptValue = [{ type: "text", content: "", start: 0, end: 0 }]
        },
        roleSubmitBlocked: () => false,
        prompt: {
          current: () => promptValue,
          set: (next) => {
            promptValue = next
          },
        },
        imageCount: () => 0,
        commentCount: () => 0,
        mode: () => mode,
        setMode: (next) => {
          mode = next
        },
        promptLength: (prompt) =>
          prompt.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
        clearBoot: () => undefined,
        registerRetry: (next) => {
          registeredRetry = next
        },
      })

      expect(retry.onRetry()).toBeUndefined()
      await retry.handleSubmit(new Event("submit", { cancelable: true }))
      expect(rawCalls).toBe(1)
      expect(retry.onRetry()).toBeFunction()
      expect(registeredRetry).toBeFunction()

      mode = "normal"
      registeredRetry?.()

      expect(rawCalls).toBe(2)
      expect(rawPrompts[1]).toEqual([{ type: "text", content: "first", start: 0, end: 5 }])
      expect(rawModes[1]).toBe("shell")
      expect(mode).toBe("shell")
      dispose()
    })
  })

  test("a newly mounted session composer can retry a prompt restored from the transcript", async () => {
    await createRoot(async (dispose) => {
      let promptValue: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]
      const [resetKey, setResetKey] = createSignal("session-after-navigation")
      let registeredRetry: ((prompt?: Prompt) => void) | undefined
      const rawPrompts: Prompt[] = []
      createPromptInputSubmitRetry({
        resetKey,
        rawHandleSubmit: () => {
          rawPrompts.push(promptValue)
        },
        roleSubmitBlocked: () => false,
        prompt: {
          current: () => promptValue,
          set: (next) => {
            promptValue = next
          },
        },
        imageCount: () => 0,
        commentCount: () => 0,
        mode: () => "normal",
        setMode: () => undefined,
        promptLength: (prompt) =>
          prompt.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
        clearBoot: () => undefined,
        registerRetry: (next) => {
          registeredRetry = next
        },
      })

      registeredRetry?.([{ type: "text", content: "failed first turn", start: 0, end: 17 }])

      expect(rawPrompts).toEqual([
        [{ type: "text", content: "failed first turn", start: 0, end: 17 }],
      ])

      setResetKey("same-composer-new-scope")
      await Promise.resolve()
      registeredRetry?.([{ type: "text", content: "retry after scope reset", start: 0, end: 23 }])
      expect(rawPrompts[1]).toEqual([
        { type: "text", content: "retry after scope reset", start: 0, end: 23 },
      ])
      dispose()
    })
  })

  test("role-blocked submits prevent default and skip the raw pipeline", async () => {
    await createRoot(async (dispose) => {
      let rawCalls = 0
      const retry = createPromptInputSubmitRetry({
        resetKey: () => "scope-a",
        rawHandleSubmit: () => {
          rawCalls++
        },
        roleSubmitBlocked: () => true,
        prompt: {
          current: () => [{ type: "text", content: "first", start: 0, end: 5 }],
          set: () => undefined,
        },
        imageCount: () => 0,
        commentCount: () => 0,
        mode: () => "normal",
        setMode: () => undefined,
        promptLength: () => 0,
        clearBoot: () => undefined,
      })

      const event = new Event("submit", { cancelable: true })
      await retry.handleSubmit(event)

      expect(event.defaultPrevented).toBe(true)
      expect(rawCalls).toBe(0)
      expect(retry.onRetry()).toBeUndefined()
      dispose()
    })
  })
})
