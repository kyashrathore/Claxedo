import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import * as h from "./submit.harness.test"

const {
  createSubmit, createPromptSubmit, submitEvent, settleSubmitEffects, waitForSubmitEffect,
  seedProjectCatalog, seedCommandList, sessionStatusFor, localSessionRef, promptLengthForTest,
  repoMainPromptScope, promptValue, state, calls, boots, apiCalls, fetchCalls, unsignedCalls,
  runtimeCalls, transportPromptAsyncCalls, sessionCreateCalls, transportClients, harnessSetCalls,
  buildRequestPartCalls, shellCalls, commandCalls, navCalls, flowEvents, handoffCalls, toasts,
  promptCalls, optimisticAdds, optimisticRemoves, promptContextItems, promptContextAdds,
  promptContextRemoves, refreshCalls, bootstrapCalls, worktreeCreateCalls, enabledAutoAccept,
} = h

beforeAll(async () => {
  await h.installSubmitMocks(mock)
})
beforeEach(() => h.resetSubmitHarness())
afterAll(() => h.restoreSubmitMocks(mock))

describe("Comment routing, shell, and slash command dispatch", () => {
  test("prepares prompt request parts without treating page comments as file attachments", async () => {
    state.demoMode = false
    promptContextItems.push(
      {
        key: "file-comment",
        type: "file",
        path: "src/app.ts",
        comment: "check this file",
      },
      {
        key: "page-comment",
        type: "file",
        path: "https://example.test/page",
        comment: "check this page",
      },
    )

    const submit = createSubmit({
      info: () => ({ id: "session-existing" }),
      sessionID: () => "session-existing",
      sessionDirectory: () => "/repo/main",
      selectedModelForSubmit: () => ({ id: "model", provider: { id: "provider" } }),
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(buildRequestPartCalls.at(-1)).toMatchObject({
      context: [
        {
          key: "file-comment",
          path: "src/app.ts",
          comment: "check this file",
        },
      ],
    })
    expect((buildRequestPartCalls.at(-1) as { context?: unknown[] }).context).toHaveLength(1)
    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      parts: [
        { id: "part-main", type: "text", text: "hello" },
        { type: "text", text: "check this page" },
      ],
    })
    expect(promptContextRemoves).toEqual(["file-comment", "page-comment"])
  })


  test("shell mode dispatches through the shell command phase", async () => {
    const submit = createSubmit({
      info: () => ({ id: "session-existing" }),
      sessionID: () => "session-existing",
      sessionDirectory: () => "/repo/main",
      mode: () => "shell",
      selectedModelForSubmit: () => ({ id: "model", provider: { id: "provider" } }),
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(calls.shell).toBe(1)
    expect(calls.async).toBe(0)
    expect(calls.transportAsync).toBe(0)
    expect(buildRequestPartCalls).toEqual([])
    expect(shellCalls.at(-1)).toMatchObject({
      sessionID: "session-existing",
      directory: "/repo/main",
      agent: "agent",
      model: { providerID: "provider", modelID: "model" },
      command: "hello",
    })
    expect(sessionStatusFor("/repo/main", "session-existing")).toEqual({ type: "busy" })
  })


  test("shell dispatch failure restores the draft and clears busy status", async () => {
    state.shellError = new Error("shell exploded")
    const modes: string[] = []
    const submit = createSubmit({
      info: () => ({ id: "session-existing" }),
      sessionID: () => "session-existing",
      sessionDirectory: () => "/repo/main",
      mode: () => "shell",
      selectedModelForSubmit: () => ({ id: "model", provider: { id: "provider" } }),
      setMode: (value) => {
        modes.push(value)
      },
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(calls.shell).toBe(0)
    expect(sessionStatusFor("/repo/main", "session-existing")).toEqual({ type: "idle" })
    expect(toasts).toContainEqual({
      title: "prompt.toast.promptSendFailed.title",
      description: "runtime exploded",
    })
    expect(promptCalls.set.at(-1)?.prompt).toBe(promptValue)
    expect(promptCalls.set.at(-1)?.cursor).toBe(5)
    expect(modes[0]).toBe("normal")
    expect(modes.at(-1)).toBe("shell")
  })


  test("slash-looking text uses the generic runtime prompt path", async () => {
    state.commandListResponse = [{ name: "build" }]
    await seedCommandList("/repo/main")
    promptValue.splice(0, promptValue.length, { type: "text", content: "/build --fast", start: 0, end: 13 })
    const submit = createSubmit({
      info: () => ({ id: "session-existing" }),
      sessionID: () => "session-existing",
      sessionDirectory: () => "/repo/main",
      selectedModelForSubmit: () => ({ id: "model", provider: { id: "provider" } }),
      imageAttachments: () => [{
        mime: "image/png",
        dataUrl: "data:image/png;base64,abc",
        filename: "shot.png",
      }],
      variant: () => "high",
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(commandCalls).toEqual([])
    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({ mode: "sync" })
    expect(calls.async).toBe(0)
    expect(calls.transportAsync).toBe(1)
    expect(buildRequestPartCalls).toHaveLength(1)
    expect(sessionStatusFor("/repo/main", "session-existing")).toEqual({ type: "idle" })
  })


  test("runtime failure for slash-looking text restores the draft", async () => {
    state.commandListResponse = [{ name: "build" }]
    await seedCommandList("/repo/main")
    state.transportPromptAsyncError = new Error("runtime exploded")
    promptValue.splice(0, promptValue.length, { type: "text", content: "/build --fast", start: 0, end: 13 })
    const submit = createSubmit({
      info: () => ({ id: "session-existing" }),
      sessionID: () => "session-existing",
      sessionDirectory: () => "/repo/main",
      selectedModelForSubmit: () => ({ id: "model", provider: { id: "provider" } }),
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(commandCalls).toEqual([])
    expect(sessionStatusFor("/repo/main", "session-existing")).toEqual({ type: "idle" })
    expect(toasts).toContainEqual({
      title: "prompt.toast.promptSendFailed.title",
      description: "runtime exploded",
    })
    expect(promptCalls.set.at(-1)?.prompt).toBe(promptValue)
    expect(promptCalls.set.at(-1)?.cursor).toBe(13)
  })

})
