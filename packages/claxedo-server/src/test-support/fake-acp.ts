#!/usr/bin/env bun
/**
 * Fake ACP Binary
 *
 * Minimal implementation of the Agent Client Protocol (ACP) JSON-RPC 2.0
 * over ndjson stdio. Used by integration tests to exercise the full
 * claxedo-server → AcpHarnessAdapter → subprocess pipeline without requiring
 * real LLM API keys.
 *
 * Wire format: one JSON object per line on stdin/stdout.
 * Requests have an `id` field and expect a response with the same `id`.
 * Notifications have no `id` and receive no response.
 */

import { randomUUID } from "crypto"

// ── Types ────────────────────────────────────────────────────────────────────

type JsonRpcMessage = {
  jsonrpc: "2.0"
  id?: number | string
  method: string
  params?: Record<string, unknown>
}

// ── State ────────────────────────────────────────────────────────────────────

const sessions = new Map<string, { cwd: string; title?: string }>()

// ── I/O helpers ──────────────────────────────────────────────────────────────

function send(msg: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

function respond(id: number | string, result: unknown) {
  send({ jsonrpc: "2.0", id, result })
}

function notify(method: string, params: unknown) {
  send({ jsonrpc: "2.0", method, params })
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

function handle(msg: JsonRpcMessage) {
  const { id, method, params } = msg

  switch (method) {
    case "initialize": {
      respond(id!, {
        protocolVersion: 1,
        agentInfo: { name: "fake-acp", version: "0.1.0" },
        agentCapabilities: {
          loadSession: {},
          sessionCapabilities: { resume: {} },
          promptCapabilities: {},
        },
      })
      break
    }

    case "session/new": {
      const sessionId = randomUUID()
      const cwd = (params?.cwd as string) ?? ""
      sessions.set(sessionId, { cwd })
      respond(id!, { sessionId })
      break
    }

    case "session/load":
    case "session/resume": {
      const sessionId = (params?.sessionId as string) ?? ""
      if (!sessions.has(sessionId)) {
        // Accept unknown sessions (they may have been created in a prior process lifetime)
        sessions.set(sessionId, { cwd: (params?.cwd as string) ?? "" })
      }
      respond(id!, {})
      break
    }

    case "session/prompt": {
      const sessionId = (params?.sessionId as string) ?? ""

      // Emit an agent_message_chunk notification before responding
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello from fake-acp" },
        },
      })

      respond(id!, { stopReason: "end_turn" })
      break
    }

    case "session/cancel": {
      // Notification — no response
      break
    }

    case "session/set_mode":
    case "session/set_model": {
      respond(id!, {})
      break
    }

    case "session/set_config_option": {
      respond(id!, { configOptions: [] })
      break
    }

    case "session/close": {
      const sessionId = (params?.sessionId as string) ?? ""
      sessions.delete(sessionId)
      respond(id!, {})
      break
    }

    case "session/list": {
      respond(id!, {
        sessions: [...sessions.entries()].map(([sid, s]) => ({
          sessionId: sid,
          cwd: s.cwd,
        })),
      })
      break
    }

    case "session/fork": {
      const newId = randomUUID()
      const cwd = sessions.get((params?.sessionId as string) ?? "")?.cwd ?? ""
      sessions.set(newId, { cwd })
      respond(id!, { sessionId: newId })
      break
    }

    default: {
      // Unknown method — respond with error if it's a request
      if (id !== undefined) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        })
      }
      break
    }
  }
}

// ── Stdin reader ─────────────────────────────────────────────────────────────

let buffer = ""
process.stdin.setEncoding("utf-8")
process.stdin.on("data", (chunk: string) => {
  buffer += chunk
  const lines = buffer.split("\n")
  buffer = lines.pop() ?? ""
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      handle(JSON.parse(trimmed) as JsonRpcMessage)
    } catch (err) {
      process.stderr.write(`fake-acp: parse error: ${err}\n`)
    }
  }
})

process.stdin.on("end", () => {
  process.exit(0)
})

process.stdin.resume()
