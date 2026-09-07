import { describe, expect, test } from "bun:test"
import { SESSION_CORE_ROUTE_ACCESS } from "../session-access-policy"
import { createWorkspaceRuntimeClient } from "./index"

type Leaf = (input: Record<string, unknown>) => Promise<unknown>

const ids = {
  sessionID: "sid",
  permissionID: "pid",
  requestID: "qid",
  modeId: "mode",
  objective: "goal",
  messageID: "msg",
  providerID: "provider",
  modelID: "model",
}

function inventoryPattern(method: string, pathname: string) {
  const path = pathname
    .replace(/^\/session\/sid\/permissions\/pid$/, "/session/:sessionId/permissions/:permId")
    .replace(/^\/session\/sid(?=\/|$)/, "/session/:id")
    .replace(/^\/question\/qid(?=\/|$)/, "/question/:id")
  return `${method} ${path}`
}

async function invokeEvery(group: object, invoke: (leaf: Leaf) => Promise<unknown>) {
  for (const value of Object.values(group)) {
    if (typeof value === "function") await invoke(value as Leaf)
    else if (value && typeof value === "object") await invokeEvery(value, invoke)
  }
}

describe("runtime client against the session-core route inventory", () => {
  test("the session, permission, question, command and agent members cover every non-stream inventory route and nothing else", async () => {
    const seen = new Set<string>()
    const client = createWorkspaceRuntimeClient({
      baseUrl: "http://runtime.local",
      fetch: async (input, init) => {
        const request = new Request(input, init)
        seen.add(inventoryPattern(request.method, new URL(request.url).pathname))
        return Response.json({})
      },
    })

    for (const group of [client.session, client.permission, client.question, client.command, client.agent]) {
      await invokeEvery(group, (leaf) => leaf(ids))
    }

    const expected = Object.entries(SESSION_CORE_ROUTE_ACCESS)
      .filter(([, decision]) => decision.kind !== "stream")
      .map(([route]) => route)
    expect([...seen].sort()).toEqual(expected.sort())
  })
})
