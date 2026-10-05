/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { placementId, projectId, requestId, ServerError, sessionId, type AgentRequest, type AgentRequestReply, type ProductEvent, type Server, type SessionLocation } from "@/server"
import { createRequests } from "./store"

const ref: SessionLocation = { projectId: projectId("prj"), placementId: placementId("plc"), sessionId: sessionId("ses") }

function permission(id: string, tool: string): AgentRequest {
  return {
    kind: "permission",
    id: requestId(id),
    permission: { id, sessionID: "ses", permission: tool, patterns: ["/secret/path.ts"], always: [], metadata: { command: "rm -rf /" } },
  }
}

function replying(refuse: boolean) {
  const recorded: ProductEvent[] = []
  const server = {
    sessions: { reply: async () => { if (refuse) throw new ServerError({ class: "conflict", message: "already answered" }) } },
    telemetry: { record: (event: ProductEvent) => void recorded.push(event) },
  } as unknown as Server
  return { recorded, server }
}

async function decide(refuse: boolean, request: AgentRequest, answer: AgentRequestReply) {
  const { recorded, server } = replying(refuse)
  await createRoot(async (dispose) => {
    const requests = createRequests(server)
    requests.read(ref, [request], 1)
    await requests.reply(ref, request.id, answer)
    dispose()
  })
  return recorded
}

test("an accepted permission answer records the decision and the tool's kind, nothing of its patterns or input", async () => {
  expect(await decide(false, permission("p1", "Bash"), { kind: "permission", reply: "once" }))
    .toEqual([{ event: "permission_decided", properties: { decision: "allow", tool_kind: "bash" } }])
  expect(await decide(false, permission("p2", "edit_file"), { kind: "permission", reply: "reject" }))
    .toEqual([{ event: "permission_decided", properties: { decision: "deny", tool_kind: "edit" } }])
  expect(await decide(false, permission("p3", "mcp__linear__create_issue"), { kind: "permission", reply: { optionId: "allow_always" } }))
    .toEqual([{ event: "permission_decided", properties: { decision: "option", tool_kind: "mcp" } }])
})

test("a refused answer and a question's answer record nothing", async () => {
  expect(await decide(true, permission("p4", "Bash"), { kind: "permission", reply: "always" })).toEqual([])
  const question: AgentRequest = { kind: "question", id: requestId("q1"), question: { id: "q1", sessionID: "ses", questions: [] } as never }
  expect(await decide(false, question, { kind: "question", answers: [] })).toEqual([])
})
