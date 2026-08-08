/**
 * The OpenCode rail's subagent wire, end to end through the host.
 *
 * `GET /session/:id/subagents` is the read path the app hydrates its subagent
 * registry from, and the `task` renderer draws NOTHING for a delegation that
 * resolves to no subagent. Every other rail fills that read path from its
 * adapter's own store; OpenCode's sessions live in the engine, so the host has
 * to hand its store to the adapter — and when that wire was missing, a real
 * `task` call produced a real child Session and an empty card list.
 *
 * The engine here is a fake handler injected exactly the way the Claxedo host
 * injects the embedded one (`opencodeRequest`), publishing the same `task` tool
 * part shape `packages/opencode/src/tool/task.ts` emits: `state.metadata`
 * carrying `{ parentSessionId, sessionId }`.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "fs"
import os from "os"
import path from "path"
import type { OpenCodeRequestFn } from "@claxedo/agent-sdk-runtime/adapters"
import { createWorkspaceHost } from "./runtime"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"

const loopbackExposure = loopbackWorkspaceRuntimeExposure()
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  delete process.env.WORKSPACE_RUNTIME_DIRECTORY
  delete process.env.WORKSPACE_RUNTIME_RUNNER
})

function taskPartEvent(input: {
  parentSessionId: string
  childSessionId: string
  status: "running" | "completed"
}) {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: input.parentSessionId,
      part: {
        id: "prt_task",
        sessionID: input.parentSessionId,
        messageID: "msg_asst",
        type: "tool",
        callID: "call_task_1",
        tool: "task",
        state: {
          status: input.status,
          input: { description: "Verify child delegation", subagent_type: "general" },
          metadata: { parentSessionId: input.parentSessionId, sessionId: input.childSessionId },
          ...(input.status === "completed" ? { output: "done", title: "task" } : {}),
          time: { start: 1, end: 2 },
        },
      },
      time: 2,
    },
  }
}

describe("opencode subagents reach the host read path", () => {
  test("a task delegation is listed for its parent session", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wr-opencode-subagent-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    process.env.WORKSPACE_RUNTIME_RUNNER = "opencode"
    const storeRoot = path.join(dir, ".claxedo", "store")
    const enc = new TextEncoder()
    const parentSessionId = "ses_parent"
    const childSessionId = "ses_child"
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined

    const engine: OpenCodeRequestFn = async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/global/event") {
        return new Response(new ReadableStream<Uint8Array>({ start: (next) => { stream = next } }), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      }
      if (url.pathname === "/session" && request.method === "POST") {
        return Response.json({ id: parentSessionId }, { status: 200 })
      }
      if (url.pathname === `/session/${parentSessionId}/prompt_async`) {
        queueMicrotask(() => {
          for (const event of [
            taskPartEvent({ parentSessionId, childSessionId, status: "running" }),
            taskPartEvent({ parentSessionId, childSessionId, status: "completed" }),
            {
              type: "message.part.delta",
              properties: {
                sessionID: parentSessionId,
                messageID: "msg_asst",
                partID: "prt_text",
                field: "text",
                delta: "delegated",
              },
            },
            { type: "session.idle", properties: { sessionID: parentSessionId } },
          ]) {
            stream?.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`))
          }
        })
        return new Response(null, { status: 204 })
      }
      if (url.pathname === `/session/${parentSessionId}/message`) return Response.json([])
      return Response.json({})
    }

    const app = new Hono()
    const host = createWorkspaceHost({
      opencodeRequest: engine,
      harness: { id: "opencode", access: "native" },
      storeRoot,
    })
    host.mount(app, { exposure: loopbackExposure })
    try {
      const created = await app.request(`http://localhost/session?directory=${encodeURIComponent(dir)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: parentSessionId, title: "Delegating session" }),
      })
      expect(created.status).toBe(201)

      const prompted = await app.request(
        `http://localhost/session/${parentSessionId}/message?directory=${encodeURIComponent(dir)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parts: [{ type: "text", text: "delegate one child task" }] }),
        },
      )
      expect(prompted.status).toBe(200)

      const listed = await app.request(
        `http://localhost/session/${parentSessionId}/subagents?directory=${encodeURIComponent(dir)}`,
      )
      expect(listed.status).toBe(200)
      const rows = await listed.json() as Array<{
        subagentKey: string
        status?: string
        childSessionId?: string
        description?: string
        subagentType?: string
        transcript?: { kind: string; ref?: string }
        toolCallEdges?: Array<{ toolCallId: string; role: string }>
      }>
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        status: "completed",
        childSessionId,
        description: "Verify child delegation",
        subagentType: "general",
        transcript: { kind: "live", ref: childSessionId },
      })
      // The association is the explicit spawn edge, never the child's title.
      expect(rows[0]?.toolCallEdges).toEqual([{ toolCallId: "call_task_1", role: "spawn", revision: 1 }] as never)
    } finally {
      host.dispose()
    }
  })
})
