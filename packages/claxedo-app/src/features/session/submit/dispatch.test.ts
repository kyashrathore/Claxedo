import { describe, expect, test } from "bun:test"
import { dispatchPrompt, dispatchShellCommand, dispatchSlashCommand } from "./dispatch"
import type { PromptDispatchPayload, ShellDispatchPayload, SlashCommandDispatchPayload } from "./types"

// Rubric T2: per-phase test coverage for `session/submit/*`. The dispatch
// phase is the thin boundary between phase orchestration and the chosen
// session client. The contract is small but explicit: demo returns its
// reply through `onDemoReply`, async (live) never does, and errors in
// either the prompt or the shell/slash methods bubble.

const payload: PromptDispatchPayload = {
  sessionID: "ses_1",
  directory: "/repo/main",
  agent: "build",
  model: { providerID: "anthropic", modelID: "sonnet" },
  messageID: "msg_1",
  parts: [],
}

const shellPayload: ShellDispatchPayload = {
  sessionID: "ses_1",
  directory: "/repo/main",
  agent: "build",
  model: { providerID: "anthropic", modelID: "sonnet" },
  command: "ls -la",
}

const slashPayload: SlashCommandDispatchPayload = {
  sessionID: "ses_1",
  directory: "/repo/main",
  command: "build",
  arguments: "--fast",
  agent: "build",
  model: "anthropic/sonnet",
  parts: [],
}

describe("dispatchPrompt", () => {
  test("demo path returns the reply via onDemoReply and never calls promptAsync", async () => {
    let promptCalls = 0
    let promptAsyncCalls = 0
    let replyReceived: { info: { id: string }; parts: unknown[] } | undefined
    await dispatchPrompt({
      client: {
        session: {
          prompt: async () => {
            promptCalls++
            return {
              data: {
                info: { id: "msg_2", role: "assistant", sessionID: "ses_1", time: { created: 1 } },
                parts: [{ id: "part_1", type: "text", text: "hi", sessionID: "ses_1", messageID: "msg_2" }],
              } as never,
            }
          },
          promptAsync: async () => {
            promptAsyncCalls++
            return undefined
          },
        },
      },
      payload,
      demo: true,
      onDemoReply: (reply) => {
        replyReceived = reply as never
      },
    })
    expect(promptCalls).toBe(1)
    expect(promptAsyncCalls).toBe(0)
    expect(replyReceived?.info.id).toBe("msg_2")
  })

  test("demo path with no reply data skips onDemoReply", async () => {
    let invoked = false
    await dispatchPrompt({
      client: {
        session: {
          prompt: async () => ({ data: undefined }) as never,
          promptAsync: async () => undefined,
        },
      },
      payload,
      demo: true,
      onDemoReply: () => {
        invoked = true
      },
    })
    expect(invoked).toBe(false)
  })

  test("demo path throws when the client returns an error", async () => {
    let caught: unknown
    try {
      await dispatchPrompt({
        client: {
          session: {
            prompt: async () => ({ error: new Error("upstream rejected") }) as never,
            promptAsync: async () => undefined,
          },
        },
        payload,
        demo: true,
        onDemoReply: () => undefined,
      })
    } catch (err) {
      caught = err
    }
    expect((caught as Error).message).toBe("upstream rejected")
  })

  test("live path calls promptAsync and skips onDemoReply", async () => {
    let promptCalls = 0
    let promptAsyncCalls = 0
    let demoReplyCalls = 0
    await dispatchPrompt({
      client: {
        session: {
          prompt: async () => {
            promptCalls++
            return { data: undefined } as never
          },
          promptAsync: async () => {
            promptAsyncCalls++
            return undefined
          },
        },
      },
      payload,
      demo: false,
      onDemoReply: () => {
        demoReplyCalls++
      },
    })
    expect(promptCalls).toBe(0)
    expect(promptAsyncCalls).toBe(1)
    expect(demoReplyCalls).toBe(0)
  })

  test("live path bubbles errors from promptAsync", async () => {
    let caught: unknown
    try {
      await dispatchPrompt({
        client: {
          session: {
            prompt: async () => ({ data: undefined }) as never,
            promptAsync: async () => {
              throw new Error("network blip")
            },
          },
        },
        payload,
        demo: false,
        onDemoReply: () => undefined,
      })
    } catch (err) {
      caught = err
    }
    expect((caught as Error).message).toBe("network blip")
  })
})

describe("dispatchShellCommand", () => {
  test("forwards the payload to session.shell exactly once", async () => {
    let received: ShellDispatchPayload | undefined
    await dispatchShellCommand({
      client: {
        session: {
          shell: async (input) => {
            received = input
            return undefined
          },
        },
      },
      payload: shellPayload,
    })
    expect(received).toEqual(shellPayload)
  })

  test("bubbles shell errors", async () => {
    let caught: unknown
    try {
      await dispatchShellCommand({
        client: {
          session: {
            shell: async () => {
              throw new Error("shell exploded")
            },
          },
        },
        payload: shellPayload,
      })
    } catch (err) {
      caught = err
    }
    expect((caught as Error).message).toBe("shell exploded")
  })
})

describe("dispatchSlashCommand", () => {
  test("forwards the payload to session.command exactly once", async () => {
    let received: SlashCommandDispatchPayload | undefined
    await dispatchSlashCommand({
      client: {
        session: {
          command: async (input) => {
            received = input
            return undefined
          },
        },
      },
      payload: slashPayload,
    })
    expect(received).toEqual(slashPayload)
  })
})
