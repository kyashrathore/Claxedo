import { GlobalBus } from "@/bus/global"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Instance } from "@/project/instance"
import { Pty } from "@/pty"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { onPlannerStopped, onSessionStopped, type ExecutionAdapter } from "@opencode-ai/workgraph"
import { Worktree } from "../worktree"

const model = {
  providerID: "opencode",
  modelID: "minimax-m2.5-free",
} as const

function shared(kind: string) {
  return ["research", "docs", "design", "review"].includes(kind)
}

function wait(dir: string, boot: () => void) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      GlobalBus.off("event", on)
      reject(new Error(`Worktree bootstrap timed out for ${dir}`))
    }, 30_000)

    const done = (fn: () => void) => {
      clearTimeout(timeout)
      GlobalBus.off("event", on)
      fn()
    }

    const on = (event: { directory?: string; payload: { type?: string; properties?: Record<string, unknown> } }) => {
      if (event.directory !== dir) return
      if (event.payload?.type === Worktree.Event.Ready.type) {
        done(resolve)
        return
      }
      if (event.payload?.type !== Worktree.Event.Failed.type) return
      done(() => reject(new Error(String(event.payload?.properties?.message ?? `Worktree failed for ${dir}`))))
    }

    GlobalBus.on("event", on)
    try {
      boot()
    } catch (err) {
      done(() => reject(err))
    }
  })
}

function open(db: any, runId: string, nodeId: string, sessionId: string) {
  return db
    .query(
      "SELECT attempt_id FROM attempts_current WHERE run_id = ? AND node_id = ? AND session_id = ? AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1",
    )
    .get(runId, nodeId, sessionId) as { attempt_id: string } | null
}

export function createWorkGraphExecution(db: any): ExecutionAdapter {
  const execution: ExecutionAdapter = {
    async launch(input) {
      const dir = input.directory ?? Instance.directory
      const isolated = !shared(input.kind)
      const info = isolated ? await Worktree.makeWorktreeInfo(input.title) : { directory: dir }
      if (isolated) {
        const boot = await Worktree.createFromInfo(info)
        await wait(info.directory, boot)
      }
      const session = await Instance.provide({
        directory: info.directory,
        init: InstanceBootstrap,
        fn: async () => Session.create({ title: input.title }),
      })
      void Instance.provide({
        directory: info.directory,
        init: InstanceBootstrap,
        fn: async () => {
          await SessionPrompt.prompt({
            sessionID: session.id,
            model,
            parts: [{ type: "text", text: input.prompt }],
          })
        },
      }).catch((err) => {
        console.error("[workgraph] failed to prompt session", err)
      })
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const stop = async (message: string) => {
        if (done) return
        if (input.node_id && !open(db, input.run_id, input.node_id, session.id)) {
          done = true
          GlobalBus.off("event", on)
          return
        }
        done = true
        GlobalBus.off("event", on)
        if (timer) clearTimeout(timer)
        if (!input.node_id) {
          await onPlannerStopped(db, input.run_id, session.id, message).catch((err) => {
            console.error("[workgraph] failed to settle planner session", err)
          })
          return
        }
        await onSessionStopped(
          db,
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
              directory: meta?.directory ?? info.directory,
            }),
          message,
        ).catch((err) => {
          console.error("[workgraph] failed to settle session-backed attempt", err)
        })
      }
      const on = (event: { directory?: string; payload: { type?: string; properties?: Record<string, unknown> } }) => {
        if (event.directory !== info.directory) return
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
      GlobalBus.on("event", on)
      return {
        id: session.id,
        runtime_type: "workspace",
        session_id: session.id,
        directory: info.directory,
        worktree_path: isolated ? info.directory : null,
      }
    },
    async cleanup(input) {
      if (input.session_id) {
        await Instance.provide({
          directory: input.directory ?? Instance.directory,
          init: InstanceBootstrap,
          fn: async () => Session.setArchived({ sessionID: input.session_id!, time: Date.now() }),
        }).catch((err) => {
          console.warn("[workgraph] failed to archive session during cleanup", err)
        })
      }
      if (input.pty_id) {
        await Pty.remove(input.pty_id).catch((err) => {
          console.warn("[workgraph] failed to remove PTY during cleanup", err)
        })
      }
      if (input.mode !== "delete" || !input.worktree_path) return
      await Worktree.remove({ directory: input.worktree_path }).catch((err) => {
        console.warn("[workgraph] failed to remove worktree during cleanup", err)
      })
    },
  }

  return execution
}
