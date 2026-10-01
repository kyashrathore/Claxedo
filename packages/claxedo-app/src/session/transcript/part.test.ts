/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { placementId, projectId, sessionId, type Server, type SessionLocation, type TranscriptPart } from "@/server"
import { createTranscriptContext, type TranscriptDeps } from "./context"
import { replaceLatest } from "./conversation"
import { loadPart } from "./part"

const ref: SessionLocation = { projectId: projectId("project-1"), placementId: placementId("placement-1"), sessionId: sessionId("ses_1") }

const completed = (output: string) => ({ status: "completed", input: { command: "ls" }, output, title: "ls", metadata: {}, time: { start: 1, end: 2 } }) as const
const tool = (output: string, headerOnly?: true): TranscriptPart => ({ id: "p1", sessionID: "ses_1", messageID: "msg_1_r", type: "tool", callID: "c1", tool: "bash", state: completed(output), ...(headerOnly ? { headerOnly } : {}) })
const turn = (part: TranscriptPart) => ({
  entries: [
    { info: { id: "msg_1", role: "user", sessionID: "ses_1", time: { created: 1 } }, parts: [] },
    { info: { id: "msg_1_r", role: "assistant", sessionID: "ses_1", parentID: "msg_1", time: { created: 1, completed: 2 } }, parts: [part] },
  ],
}) as never

function setup() {
  const reads: string[] = []
  const server = {
    sessions: {
      part: async (_ref: SessionLocation, messageId: string, partId: string) => {
        reads.push(`${messageId}/${partId}`)
        return tool("a\nb")
      },
    },
  } as unknown as Server
  const deps = { pageShape: () => ({ rows: 40, cols: 100, reasoning: false, shell: false, edit: false }) } as unknown as TranscriptDeps
  return { server, deps, reads }
}

test("part: a row sent as its header reads its whole part once when it opens, and a whole part reads nothing", async () => {
  const { server, deps, reads } = setup()
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, ref, deps)
    replaceLatest(context.setData, turn(tool("", true)))
    await Promise.all([loadPart(context, "msg_1_r", "p1"), loadPart(context, "msg_1_r", "p1")])
    expect(reads).toEqual(["msg_1_r/p1"])
    expect(context.data.parts["msg_1_r"]?.[0]).toEqual(tool("a\nb"))
    await loadPart(context, "msg_1_r", "p1")
    expect(reads).toEqual(["msg_1_r/p1"])
    dispose()
  })
})
