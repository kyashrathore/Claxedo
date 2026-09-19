import { describe, expect, test } from "bun:test"
import {
  SESSION_CORE_ROUTE_ACCESS,
  sessionAccessRequiresWrite,
  sessionAccessWriteClass,
} from "../session-access-policy"

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

/**
 * Mutating session-core routes that a reviewer has deliberately classified as
 * reads. Intentionally empty: every POST/PUT/PATCH/DELETE below drives a Session
 * or Goal state change, so all of them must reach the session authority with
 * the `write` scope, where the write's class then decides whether a share can
 * carry it. Adding an entry means someone decided a mutating verb changes no
 * state — say why here.
 */
const MUTATING_ROUTES_CLASSIFIED_AS_READS: readonly string[] = []

const EXPECTED_SESSION_CORE_ROUTES = [
  "DELETE /session/:id",
  "DELETE /session/:id/goal",
  "GET /agent",
  "GET /command",
  "GET /experimental/session",
  "GET /permission",
  "GET /permission/modes",
  "GET /question",
  "GET /session",
  "GET /session/:id",
  "GET /session/:id/capabilities",
  "GET /session/:id/config",
  "GET /session/:id/goal",
  "GET /session/:id/goal/capabilities",
  "GET /session/:id/goal/state",
  "GET /session/:id/message",
  "GET /session/:id/permission-mode",
  "GET /session/:id/queue",
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
  "POST /session/:id/goal",
  "POST /session/:id/goal/pause",
  "POST /session/:id/goal/resume",
  "POST /session/:id/goal/stop",
  "POST /session/:id/message",
  "POST /session/:id/prompt_async",
  "POST /session/:id/queue/:seq/:action",
  "POST /session/:id/revert",
  "POST /session/:id/shell",
  "POST /session/:id/summarize",
  "POST /session/:id/unrevert",
  "POST /session/:sessionId/permissions/:permId",
  "PUT /session/:id/permission-mode",
]

describe("Claxedo client-presentation session route inventory", () => {
  test("keeps the externally consumed route and method set explicit", async () => {
    const source = await Bun.file(new URL("./session-core.ts", import.meta.url)).text()
    const routes = [...source.matchAll(/\.(get|post|patch|put|delete)\("([^"]+)"/g)]
      .map((match) => `${match[1].toUpperCase()} ${match[2]}`)
      .sort()

    expect(routes).toEqual(EXPECTED_SESSION_CORE_ROUTES)
  })

  test("assigns every route an explicit session-policy or workspace decision", async () => {
    const source = await Bun.file(new URL("./session-core.ts", import.meta.url)).text()
    const routes = [...source.matchAll(/\.(get|post|patch|put|delete)\("([^"]+)"/g)]
      .map((match) => `${match[1].toUpperCase()} ${match[2]}`)
      .sort()

    expect(Object.keys(SESSION_CORE_ROUTE_ACCESS).sort()).toEqual(routes)
    expect(SESSION_CORE_ROUTE_ACCESS).toMatchObject({
      "GET /session": { kind: "filter", operation: "session_list" },
      "GET /session/status": { kind: "filter", operation: "session_status" },
      "GET /permission": { kind: "filter", operation: "permission_list" },
      "GET /question": { kind: "filter", operation: "question_list" },
      "POST /session/:id/message": { kind: "authorize", operation: "prompt" },
    })
    expect(Object.values(SESSION_CORE_ROUTE_ACCESS).every((decision) => decision.kind !== undefined)).toBe(true)
  })

  test("requires workspace write authority for every mutating route", () => {
    const mutating = Object.entries(SESSION_CORE_ROUTE_ACCESS)
      .filter(([route]) => MUTATING_METHODS.has(route.split(" ")[0]))

    // Guards the guard: if the route table or its key shape ever changes, an
    // empty match must not silently pass this assertion.
    expect(mutating.length).toBe(
      EXPECTED_SESSION_CORE_ROUTES.filter((route) => MUTATING_METHODS.has(route.split(" ")[0])).length,
    )
    expect(mutating.length).toBeGreaterThan(0)

    const notWriteGated = mutating.flatMap(([route, decision]) => {
      if (MUTATING_ROUTES_CLASSIFIED_AS_READS.includes(route)) return []
      const method = route.split(" ")[0]
      if (decision.kind === "workspace") return [route]
      return sessionAccessRequiresWrite({ operation: decision.operation, method }) ? [] : [route]
    })

    expect(notWriteGated).toEqual([])
  })

  test("admits a session share to the agent's turn and to nothing else on the session", () => {
    const byClass = Object.entries(SESSION_CORE_ROUTE_ACCESS).reduce<Record<string, string[]>>(
      (grouped, [route, decision]) => {
        const writeClass = decision.kind === "workspace"
          ? "workspace"
          : sessionAccessWriteClass({ operation: decision.operation }) ?? "read"
        return { ...grouped, [writeClass]: [...grouped[writeClass] ?? [], route].sort() }
      },
      {},
    )

    expect(byClass.agent_turn).toEqual([
      "POST /question/:id/reject",
      "POST /question/:id/reply",
      "POST /session/:id/abort",
      "POST /session/:id/message",
      "POST /session/:id/prompt_async",
      "POST /session/:id/queue/:seq/:action",
      "POST /session/:sessionId/permissions/:permId",
    ])
    expect(byClass.session_control).toEqual([
      "DELETE /session/:id",
      "DELETE /session/:id/goal",
      "PATCH /session/:id",
      "PATCH /session/:id/config",
      "POST /session",
      "POST /session/:id/command",
      "POST /session/:id/fork",
      "POST /session/:id/goal",
      "POST /session/:id/goal/pause",
      "POST /session/:id/goal/resume",
      "POST /session/:id/goal/stop",
      "POST /session/:id/revert",
      "POST /session/:id/shell",
      "POST /session/:id/summarize",
      "POST /session/:id/unrevert",
      "PUT /session/:id/permission-mode",
    ])
    expect(byClass.read).toContain("GET /session/:id/queue")
  })

})
