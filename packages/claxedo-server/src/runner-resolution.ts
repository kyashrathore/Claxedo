import { runnerHostForRunner, type RunnerHost } from "./architecture"
import { defaultRunner, loadUserConfig, type RunnerType } from "./agent-config"
import { sessionMeta } from "./session-meta"
import { getSessionConfig, normalize, type SessionRunner } from "./session-runner"
import { resolveWorkspace } from "./workspace-store"

type Input = {
  type?: string | null
  binary?: string | null
  model?: string | null
  sessionId?: string | null
  workspaceId?: string | null
  directory?: string | null
}

export function parseRunner(input: Pick<Input, "type" | "binary" | "model">) {
  if (
    input.type !== "claude-acp"
    && input.type !== "codex-acp"
    && input.type !== "cursor-acp"
    && input.type !== "opencode"
    && input.type !== "pi"
  ) return
  return normalize({
    type: input.type,
    ...(input.type === "claude-acp" || input.type === "codex-acp" || input.type === "cursor-acp"
      ? {
          ...(input.binary ? { binary: input.binary } : {}),
          ...(input.model ? { model: input.model } : {}),
        }
      : input.type === "pi" && input.model
      ? { model: input.model }
      : {}),
  } satisfies SessionRunner)
}

async function sessionRunner(input: Pick<Input, "sessionId" | "workspaceId" | "directory">) {
  if (!input.sessionId) return
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId ?? undefined,
    directory: input.directory ?? undefined,
    create: !!input.directory,
  })
  if (ws) {
    const cfg = getSessionConfig(ws.id, input.sessionId)
    if (cfg?.runner) return normalize(cfg.runner)
  }
  const meta = await sessionMeta(input.sessionId)
  if (!meta?.directory) return
  const hit = await resolveWorkspace({
    directory: meta.directory,
  })
  if (!hit) return
  const cfg = getSessionConfig(hit.id, input.sessionId)
  if (cfg?.runner) return normalize(cfg.runner)
}

export async function resolveRunnerForRequest(input: Input = {}): Promise<SessionRunner> {
  const saved = await sessionRunner(input)
  if (saved) return saved
  const hit = parseRunner(input)
  if (hit) return hit
  return defaultRunner(await loadUserConfig())
}

export async function resolveRunnerHostForRequest(input: Input = {}): Promise<RunnerHost> {
  return runnerHostForRunner(await resolveRunnerForRequest(input))
}
