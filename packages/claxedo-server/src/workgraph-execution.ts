/**
 * WorkGraph ExecutionAdapter for claxedo-server.
 *
 * Replaces the deleted opencode-patches version. All opencode internals are
 * replaced with HTTP calls to the opencode server. No Instance.provide() calls.
 */

import Database from "better-sqlite3"
import { onPlannerStopped, onSessionStopped, type ExecutionAdapter } from "@opencode-ai/workgraph"

/**
 * The workgraph package accepts a raw sqlite db that doubles as an execution
 * store (duck-typed). We type it as the sqlite instance for our `.prepare()`
 * calls and cast at the workgraph boundary where it's used as a store.
 */
type WorkGraphDb = InstanceType<typeof Database>
import type { OpencodeEventsHandle, OpencodeEvent } from "./opencode-events"
import { opencodeHeaders } from "./opencode-auth"

const model = {
  providerID: "opencode",
  modelID: "minimax-m2.5-free",
} as const

function shared(kind: string) {
  return ["research", "docs", "design", "review"].includes(kind)
}

/** Wait for a worktree bootstrap to complete via SSE events. */
async function createIsolatedWorktree(
  dir: string,
  name: string,
  opencodeUrl: string,
  opencodeEvents: OpencodeEventsHandle,
): Promise<string> {
  // Register a buffer listener BEFORE calling the endpoint so we don't miss
  // a worktree.ready event that arrives while the fetch is in-flight.
  const buffered: OpencodeEvent[] = []
  const bufferFn = (e: OpencodeEvent) => buffered.push(e)
  opencodeEvents.on(bufferFn)

  let worktreeDir: string
  try {
    const res = await fetch(`${opencodeUrl}/experimental/worktree`, {
      method: "POST",
      headers: opencodeHeaders({
        "Content-Type": "application/json",
        "x-opencode-directory": dir,
      }),
      body: JSON.stringify({ name }),
    })
    if (!res.ok) {
      const txt = await res.text()
      throw new Error(`Worktree create failed: ${res.status} ${txt}`)
    }
    const data = (await res.json()) as { directory?: string; info?: { directory?: string } }
    worktreeDir = data.directory ?? data.info?.directory ?? ""
    if (!worktreeDir) throw new Error("Worktree endpoint returned no directory")
  } finally {
    opencodeEvents.off(bufferFn)
  }

  // Check if the event arrived while we were awaiting the request.
  for (const event of buffered) {
    if (event.directory !== worktreeDir) continue
    if (event.payload?.type === "worktree.ready") return worktreeDir
    if (event.payload?.type === "worktree.failed") {
      throw new Error(String(event.payload?.properties?.message ?? `Worktree failed for ${worktreeDir}`))
    }
  }

  // Wait for the event. No await between here and opencodeEvents.on(listener),
  // so no events can slip through the gap (JS single-threaded).
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      opencodeEvents.off(listener)
      reject(new Error(`Worktree bootstrap timed out for ${worktreeDir}`))
    }, 30_000)

    const listener = (event: OpencodeEvent) => {
      if (event.directory !== worktreeDir) return
      if (event.payload?.type === "worktree.ready") {
        clearTimeout(timeout)
        opencodeEvents.off(listener)
        resolve(worktreeDir)
      } else if (event.payload?.type === "worktree.failed") {
        clearTimeout(timeout)
        opencodeEvents.off(listener)
        reject(new Error(String(event.payload?.properties?.message ?? `Worktree failed for ${worktreeDir}`)))
      }
    }
    opencodeEvents.on(listener)
  })
}

function open(db: WorkGraphDb, runId: string, nodeId: string, sessionId: string) {
  return db
    .prepare(
      "SELECT attempt_id FROM attempts_current WHERE run_id = ? AND node_id = ? AND session_id = ? AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1",
    )
    .get(runId, nodeId, sessionId) as { attempt_id: string } | null
}

export function createWorkGraphExecution(
  db: WorkGraphDb,
  opencodeUrl: string,
  opencodeEvents: OpencodeEventsHandle,
): ExecutionAdapter {
  const execution: ExecutionAdapter = {
    async launch(input) {
      const dir = input.directory
      if (!dir) throw new Error("[workgraph] launch called without directory")

      const isolated = !shared(input.kind)
      let sessionDir = dir
      let worktreePath: string | null = null

      if (isolated) {
        sessionDir = await createIsolatedWorktree(dir, input.title, opencodeUrl, opencodeEvents)
        worktreePath = sessionDir
      }

      // POST /session { directory, title } — x-opencode-directory sets Instance context
      const sessionRes = await fetch(`${opencodeUrl}/session`, {
        method: "POST",
        headers: opencodeHeaders({
          "Content-Type": "application/json",
          "x-opencode-directory": sessionDir,
        }),
        body: JSON.stringify({ title: input.title, directory: sessionDir }),
      })
      if (!sessionRes.ok) {
        const txt = await sessionRes.text()
        throw new Error(`Session create failed: ${sessionRes.status} ${txt}`)
      }
      const session = (await sessionRes.json()) as { id: string }

      // POST /session/:id/message — fire and forget
      void fetch(`${opencodeUrl}/session/${session.id}/message`, {
        method: "POST",
        headers: opencodeHeaders({
          "Content-Type": "application/json",
          "x-opencode-directory": sessionDir,
        }),
        body: JSON.stringify({
          parts: [{ type: "text", text: input.prompt }],
          model,
        }),
      })
        .then((res) => {
          if (!res.ok) return res.text().then((t) => { throw new Error(`Prompt failed: ${res.status} ${t}`) })
        })
        .catch((err) => {
          console.error("[workgraph] failed to prompt session", err)
        })

      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const stop = async (message: string) => {
        if (done) return
        if (input.node_id && !open(db, input.run_id, input.node_id, session.id)) {
          done = true
          opencodeEvents.off(on)
          return
        }
        done = true
        opencodeEvents.off(on)
        if (timer) clearTimeout(timer)

        if (!input.node_id) {
          await onPlannerStopped(db as never, input.run_id, session.id, message).catch((err) => {
            console.error("[workgraph] failed to settle planner session", err)
          })
          return
        }
        await onSessionStopped(
          db as never,
          input.run_id,
          input.node_id,
          session.id,
          async (prompt, runId, nodeId, meta) =>
            execution.launch({
              run_id: runId,
              node_id: nodeId,
              prompt,
              role: meta?.role ?? "developer",
              kind: meta?.kind ?? "task",
              title: meta?.title ?? nodeId,
              directory: meta?.directory ?? sessionDir,
            }),
          message,
        ).catch((err) => {
          console.error("[workgraph] failed to settle session-backed attempt", err)
        })
      }

      const on = (event: OpencodeEvent) => {
        if (event.directory !== sessionDir) return
        if (event.payload?.properties?.sessionID !== session.id) return
        if (event.payload?.type === "session.error") {
          void stop(String(event.payload?.properties?.error ?? "Session failed"))
          return
        }
        if (event.payload?.type !== "session.status") return
        if ((event.payload?.properties?.status as { type?: string } | undefined)?.type !== "idle") return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          void stop("Session became idle before the task reported completion")
        }, 1_000)
      }
      opencodeEvents.on(on)

      return {
        id: session.id,
        runtime_type: "workspace",
        session_id: session.id,
        directory: sessionDir,
        worktree_path: worktreePath,
      }
    },

    async cleanup(input) {
      const dir = input.directory ?? ""

      if (input.session_id) {
        await fetch(`${opencodeUrl}/session/${input.session_id}`, {
          method: "PATCH",
          headers: opencodeHeaders({
            "Content-Type": "application/json",
            "x-opencode-directory": dir,
          }),
          body: JSON.stringify({ time: { archived: Date.now() } }),
        }).catch((err) => {
          console.warn("[workgraph] failed to archive session during cleanup", err)
        })
      }

      if (input.pty_id) {
        await fetch(`${opencodeUrl}/pty/${input.pty_id}`, {
          method: "DELETE",
          headers: opencodeHeaders({ "x-opencode-directory": dir }),
        }).catch((err) => {
          console.warn("[workgraph] failed to remove PTY during cleanup", err)
        })
      }

      if (input.mode !== "delete" || !input.worktree_path) return

      await fetch(`${opencodeUrl}/experimental/worktree`, {
        method: "DELETE",
        headers: opencodeHeaders({
          "Content-Type": "application/json",
          "x-opencode-directory": dir,
        }),
        body: JSON.stringify({ directory: input.worktree_path }),
      }).catch((err) => {
        console.warn("[workgraph] failed to remove worktree during cleanup", err)
      })
    },
  }

  return execution
}
