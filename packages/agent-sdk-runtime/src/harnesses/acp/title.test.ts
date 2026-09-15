import { describe, expect, test } from "bun:test"
import path from "node:path"
import { generateAcpTitle } from "./title"
import type { SessionTitleRequest } from "../../title-generation"

function request(): SessionTitleRequest {
  return {
    directory: path.resolve("/work"),
    system: "Name this conversation",
    user: "<conversation>User: please add tests</conversation>",
    model: { providerID: "acp", modelID: "default" },
    signal: new AbortController().signal,
  }
}

describe("generateAcpTitle", () => {
  test("returns the temp session's reply text without touching the store", async () => {
    const booted: Array<string | undefined> = []
    const proc = {
      async newSession(_directory: string, title?: string) {
        booted.push(title)
        return "title-session"
      },
      dispose() {},
      async prompt(id: string, input: { parts: Array<{ text?: string }> }, onUpdate: (update: unknown) => void) {
        expect(id).toBe("title-session")
        expect(input.parts[0]?.text).toContain("please add tests")
        onUpdate({ sessionUpdate: "agent_message_chunk", delta: "Add " })
        onUpdate({ sessionUpdate: "agent_message_chunk", delta: "tests" })
        return { stopReason: "end_turn" }
      },
      async cancel() {},
    }

    const title = await generateAcpTitle({
      getOrSpawnProcess: async () => ({ proc: proc as never }),
      boot: async (item, directory, name) => item.newSession(directory, name),
    }, "s1", request())

    expect(title).toBe("Add tests")
    expect(booted).toEqual([undefined])
  })

  test("prompt timeout cancels the temporary title session and yields null", async () => {
    const prev = process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
    process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = "5"
    const calls: string[] = []
    const proc = {
      async newSession() {
        return "title-session"
      },
      async prompt() {
        calls.push("prompt")
        return new Promise<never>(() => {})
      },
      async cancel(id: string) {
        calls.push(`cancel:${id}`)
      },
      dispose() {
        calls.push("dispose")
      },
    }

    try {
      const title = await generateAcpTitle({
        getOrSpawnProcess: async () => ({ proc: proc as never }),
        boot: async (item, directory) => item.newSession(directory),
      }, "s1", request())

      expect(title).toBeNull()
      expect(calls).toContain("prompt")
      expect(calls).toContain("cancel:title-session")
    } finally {
      if (prev === undefined) delete process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
      else process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = prev
    }
  })
})
