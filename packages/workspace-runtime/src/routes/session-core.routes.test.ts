import { describe, expect, test } from "bun:test"
import { SESSION_CORE_ROUTE_ACCESS, SESSION_V2_PROXY_ROUTE_ACCESS } from "../session-access-policy"

const EXPECTED_SESSION_CORE_ROUTES = [
  "DELETE /session/:id",
  "GET /agent",
  "GET /command",
  "GET /event",
  "GET /experimental/session",
  "GET /permission",
  "GET /permission/modes",
  "GET /question",
  "GET /session",
  "GET /session/:id",
  "GET /session/:id/capabilities",
  "GET /session/:id/config",
  "GET /session/:id/message",
  "GET /session/:id/permission-mode",
  "GET /session/:id/subagents",
  "GET /session/:id/todo",
  "GET /session/capabilities",
  "GET /session/status",
  "PATCH /session/:id",
  "PATCH /session/:id/config",
  "POST /question/:id/reject",
  "POST /question/:id/reply",
  "POST /session",
  "POST /session/:id/abort",
  "POST /session/:id/command",
  "POST /session/:id/fork",
  "POST /session/:id/message",
  "POST /session/:id/prompt_async",
  "POST /session/:id/revert",
  "POST /session/:id/unrevert",
  "POST /session/:sessionId/permissions/:permId",
  "PUT /session/:id/permission-mode",
]

describe("OpenCode-compatible session route inventory", () => {
  test("keeps the externally consumed route and method set explicit", async () => {
    const source = await Bun.file(new URL("./session-core.ts", import.meta.url)).text()
    const routes = [...source.matchAll(/\.(get|post|patch|put|delete)\(\"([^\"]+)\"/g)]
      .map((match) => `${match[1]!.toUpperCase()} ${match[2]}`)
      .sort()

    expect(routes).toEqual(EXPECTED_SESSION_CORE_ROUTES)
  })

  test("assigns every route an explicit session-policy or workspace decision", async () => {
    const source = await Bun.file(new URL("./session-core.ts", import.meta.url)).text()
    const routes = [...source.matchAll(/\.(get|post|patch|put|delete)\(\"([^\"]+)\"/g)]
      .map((match) => `${match[1]!.toUpperCase()} ${match[2]}`)
      .sort()

    expect(Object.keys(SESSION_CORE_ROUTE_ACCESS).sort()).toEqual(routes)
    expect(SESSION_CORE_ROUTE_ACCESS).toMatchObject({
      "GET /session": { kind: "filter", operation: "session_list" },
      "GET /session/status": { kind: "filter", operation: "session_status" },
      "GET /permission": { kind: "filter", operation: "permission_list" },
      "GET /question": { kind: "filter", operation: "question_list" },
      "POST /session/:id/message": { kind: "authorize", operation: "prompt" },
      "GET /event": { kind: "stream", operation: "session_event_stream" },
    })
    expect(Object.values(SESSION_CORE_ROUTE_ACCESS).every((decision) => decision.kind !== undefined)).toBe(true)
  })

  test("keeps the opaque Session V2 proxy behind a prefix-level decision", async () => {
    const runtimeSource = await Bun.file(new URL("../workspace/runtime.ts", import.meta.url)).text()
    const proxySource = await Bun.file(new URL("./session-v2-proxy.ts", import.meta.url)).text()
    const routes = [...runtimeSource.matchAll(/app\.all\("(\/api\/session[^\"]*)"/g)]
      .map((match) => `ALL ${match[1]}`)
      .sort()

    expect(Object.keys(SESSION_V2_PROXY_ROUTE_ACCESS).sort()).toEqual(routes)
    expect(proxySource).toContain("policy.authorizePrefix({")
  })
})
