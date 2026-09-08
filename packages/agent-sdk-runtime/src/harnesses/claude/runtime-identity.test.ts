import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Query } from "@anthropic-ai/claude-agent-sdk"
import { createAgentRuntime, type AgentHarnessFactory } from "../../runtime"
import { createSqliteRuntimeStore } from "../../stores/sqlite"
import { isTerminalRuntimePayload } from "../../runtime/turn-outcome"
import type { AgentHarnessFactoryContext } from "../../runtime/contracts"
import { SdkRuntimeAdapter } from "../shared/sdk-runtime-adapter"
import { removeTestTempDir } from "../shared/test-temp-dir"
import { createClaudeSdkDriver, type ClaudeSdkDriverOptions } from "./driver"

test("public Claude first turn replaces its provisional upstream binding and resumes persisted local history", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "claude-runtime-identity-"))
  const root = path.join(directory, "store")
  const sessionId = "local-claude-session"
  const upstreamSessionId = "claude-provider-session"
  const calls: Array<{ options?: { resume?: string; cwd?: string; env?: Record<string, string | undefined> } }> = []
  let releaseTail = () => {}
  let notifyTail = () => {}
  const query: ClaudeSdkDriverOptions["query"] = ((input) => {
    calls.push(input)
    const sequence = calls.length
    return Object.assign((async function* () {
      yield {
        type: "assistant", uuid: `assistant-${sequence}`, session_id: upstreamSessionId, parent_tool_use_id: null,
        message: { content: [{ type: "text", text: `Claude reply ${sequence}` }] },
      }
      yield {
        type: "result", subtype: "success", uuid: `result-${sequence}`, session_id: upstreamSessionId,
        is_error: false, usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: {},
      }
      await new Promise<void>((resolve) => { releaseTail = resolve; notifyTail() })
    })(), { close() {} }) as unknown as Query
  }) as ClaudeSdkDriverOptions["query"]

  try {
    for (const iteration of [1, 2]) {
      const store = createSqliteRuntimeStore({ root })
      const rows = store
      const harness = {
        id: "claude", access: "native",
        create: ({ eventHub }: AgentHarnessFactoryContext) => new SdkRuntimeAdapter({
          store: rows, eventHub,
          driver: (host) => createClaudeSdkDriver(host, { query, executable: () => "/fake/claude" }),
        }),
      } as unknown as AgentHarnessFactory
      const runtime = createAgentRuntime({ store, harnesses: [harness] })
      try {
        if (iteration === 1) {
          await runtime.sessions.create({
            id: sessionId, workspaceId: "workspace-claude", directory,
            harness: { id: "claude", access: "native" }, model: { providerID: "claude", modelID: "sonnet" },
          })
          expect(rows.getExecutionBinding(sessionId)).toMatchObject({
            sessionId, workspaceId: "workspace-claude", directory, connectionId: "native:claude",
            upstreamSessionId: expect.stringMatching(/^claude-sdk:/),
          })
        } else {
          expect(rows.getExecutionBinding(sessionId)?.upstreamSessionId).toBe(upstreamSessionId)
          expect(JSON.stringify(await runtime.events.list(sessionId, directory))).toContain("Claude reply 1")
        }
        const completed = (async () => {
          for await (const event of runtime.events.subscribe({ sessionId })) {
            expect(event.sessionId).toBe(sessionId)
            if (isTerminalRuntimePayload(event.payload)) {
              expect(event.payload.type).toBe("session.idle")
              break
            }
          }
        })()
        const tail = new Promise<void>((resolve) => { notifyTail = resolve })
        await runtime.turns.start({ sessionId, messageId: `user-${iteration}`, text: `Hello ${iteration}` })
        await tail
        expect(rows.getSession(sessionId)?.status, "provider result must not commit idle before query cleanup").toBe("busy")
        releaseTail()
        await completed
        expect(rows.getExecutionBinding(sessionId)).toMatchObject({ sessionId, upstreamSessionId })
        const history = await runtime.events.list(sessionId, directory)
        expect(history.every((message) => message.info.sessionID === sessionId)).toBe(true)
        expect(JSON.stringify(history)).toContain(`Claude reply ${iteration}`)
        expect(rows.getSession(upstreamSessionId)).toBeNull()
      } finally {
        releaseTail()
        await runtime.dispose()
        rows.close?.()
      }
    }
    expect(calls[0]?.options?.resume).toBeUndefined()
    expect(calls[1]?.options?.resume).toBe(upstreamSessionId)
    for (const call of calls) {
      expect(call.options?.env).toMatchObject({
        CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
        CLAUDE_CODE_ENABLE_TASKS: "1",
      })
    }
    expect(calls.every((call) => call.options?.cwd === directory)).toBe(true)
  } finally {
    removeTestTempDir(directory)
  }
})
