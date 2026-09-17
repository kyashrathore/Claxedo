import { describe, expect, test } from "bun:test"
import { SESSION_CORE_ROUTE_ACCESS } from "../session-access-policy"
import { createWorkspaceRuntimeClient } from "./index"

type Leaf = (input: Record<string, unknown>) => Promise<unknown>

const SESSION_CORE_GROUPS = ["session", "permission", "question", "command", "agent"] as const

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

async function invokeEvery(group: object, path: readonly string[], invoke: (leaf: Leaf, member: string) => Promise<unknown>) {
  for (const [key, value] of Object.entries(group)) {
    const member = [...path, key].join(".")
    if (typeof value === "function") await invoke(value as Leaf, member)
    else if (value && typeof value === "object") await invokeEvery(value, [...path, key], invoke)
  }
}

function inSessionCore(member: string) {
  return SESSION_CORE_GROUPS.some((group) => member === group || member.startsWith(`${group}.`))
}

describe("runtime client against the session-core route inventory", () => {
  // Not pinned: two members that swap each other's route still satisfy both
  // assertions, because neither the count nor the membership changes. Pinning
  // the member-to-route map would catch it and would redden on every rename of
  // a member whose route did not move.
  test("the session, permission, question, command and agent members cover every non-stream inventory route once, and no other member reaches one", async () => {
    const calls: Array<{ member: string; route: string }> = []
    let calling = ""
    const client = createWorkspaceRuntimeClient({
      baseUrl: "http://runtime.local",
      fetch: async (input, init) => {
        const request = new Request(input, init)
        calls.push({ member: calling, route: inventoryPattern(request.method, new URL(request.url).pathname) })
        return Response.json({})
      },
    })

    // The whole client, not the five groups alone: a `file`, `diff` or `pty`
    // member that reached a session-core path is invisible to a walk that never
    // calls it.
    await invokeEvery(client, [], async (leaf, member) => {
      calling = member
      // The route is recorded in `fetch`, before any decoding. One fixture
      // reply cannot satisfy every member's contract — `promptAsync` requires
      // 204 and the rest require a body — and what a member makes of the reply
      // is not what this test reads.
      try {
        return await leaf(ids)
      } catch {
        return undefined
      }
    })

    const inventory = Object.keys(SESSION_CORE_ROUTE_ACCESS)

    expect(calls.filter((call) => inventory.includes(call.route) && !inSessionCore(call.member))).toEqual([])

    // Sorted arrays, not sets: a second member on a covered route survives a
    // set and shows up here as a duplicate.
    const reached = calls.filter((call) => inSessionCore(call.member)).map((call) => call.route)
    expect(reached.sort()).toEqual([...inventory].sort())
  })
})
