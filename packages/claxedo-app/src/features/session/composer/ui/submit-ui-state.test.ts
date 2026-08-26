import { afterEach, describe, expect, test } from "bun:test"
import { createSignal, flush } from "solid-js"
import type { Prompt } from "@/features/session/providers/prompt"
import { createPromptInputBootState, createPromptInputSubmitRetry } from "./submit-ui-state"
import { mountReactive } from "@/lib/test-support/reactive-root"

// Each factory owns memos and effects, so it is built under a root. Everything
// the composer calls afterwards — `setBoot`, `handleSubmit`, a registered retry
// — runs from a DOM event with no owner on the stack, which is also the only
// shape Solid 2's dev build allows for a reactive write.
const mounted: (() => void)[] = []
afterEach(() => {
  while (mounted.length) mounted.pop()!()
})

const mount = <T>(build: () => T) => {
  const [value, dispose] = mountReactive(build)
  mounted.push(dispose)
  return value
}

describe("prompt input submit UI state", () => {
  test("boot state formats labels and clears once work starts", async () => {
    const [working, setWorking] = createSignal(false)
    const boot = mount(() =>
      createPromptInputBootState({
        working,
        canAbort: () => true,
      }),
    )

    boot.setBoot({ harness: "Claude" })
    // Solid 2 stages signal writes until the scheduler flushes, and these are
    // all memos the composer renders from — i.e. read after a flush.
    flush()
    expect(boot.booting()).toBe(true)
    flush()
    expect(boot.busy()).toBe(true)
    flush()
    expect(boot.bootText()).toBe("Booting Claude...")

    boot.setBoot({ harness: "Claude", phase: "sending" })
    flush()
    expect(boot.bootText()).toBe("Sending first message...")

    setWorking(true)
    await Promise.resolve()
    flush()
    expect(boot.booting()).toBe(false)
    flush()
    expect(boot.stoppable()).toBe(true)
  })

  test("submit retry captures a non-empty prompt and restores it before resubmitting", async () => {
    let promptValue: Prompt = [{ type: "text", content: "first", start: 0, end: 5 }]
    let mode: "normal" | "shell" = "shell"
    let rawCalls = 0
    let registeredRetry: (() => void) | undefined
    const rawPrompts: Prompt[] = []
    const rawModes: Array<"normal" | "shell"> = []
    const retry = mount(() =>
      createPromptInputSubmitRetry({
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
        promptLength: (prompt) => prompt.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
        clearBoot: () => undefined,
        registerRetry: (next) => {
          registeredRetry = next
        },
      }),
    )

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
  })

  test("a newly mounted session composer can retry a prompt restored from the transcript", async () => {
    let promptValue: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]
    const [resetKey, setResetKey] = createSignal("session-after-navigation")
    let registeredRetry: ((prompt?: Prompt) => void) | undefined
    const rawPrompts: Prompt[] = []
    mount(() =>
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
        promptLength: (prompt) => prompt.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
        clearBoot: () => undefined,
        registerRetry: (next) => {
          registeredRetry = next
        },
      }),
    )

    registeredRetry?.([{ type: "text", content: "failed first turn", start: 0, end: 17 }])

    expect(rawPrompts).toEqual([[{ type: "text", content: "failed first turn", start: 0, end: 17 }]])

    setResetKey("same-composer-new-scope")
    await Promise.resolve()
    registeredRetry?.([{ type: "text", content: "retry after scope reset", start: 0, end: 23 }])
    expect(rawPrompts[1]).toEqual([{ type: "text", content: "retry after scope reset", start: 0, end: 23 }])
  })

  test("role-blocked submits prevent default and skip the raw pipeline", async () => {
    let rawCalls = 0
    const retry = mount(() =>
      createPromptInputSubmitRetry({
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
      }),
    )

    const event = new Event("submit", { cancelable: true })
    await retry.handleSubmit(event)

    expect(event.defaultPrevented).toBe(true)
    expect(rawCalls).toBe(0)
    expect(retry.onRetry()).toBeUndefined()
  })
})
