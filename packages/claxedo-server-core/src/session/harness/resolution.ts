import type { HarnessHost } from "../../platform/runtime/profile"
import { loadUserConfig } from "../../agent-config"
import { sessionMeta } from "@claxedo/server-core/session/meta/index"
import { getSessionConfig, normalize, type SessionHarness } from "./index"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"

type Input = {
  sessionId?: string | null
  workspaceId?: string | null
  directory?: string | null
}

async function sessionHarness(
  input: Pick<Input, "sessionId" | "workspaceId" | "directory">,
): Promise<SessionHarness | undefined> {
  if (!input.sessionId) return undefined
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId ?? undefined,
    directory: input.directory ?? undefined,
    create: !!input.directory,
  })
  if (ws) {
    const cfg = getSessionConfig(ws.id, input.sessionId)
    if (cfg?.harness) return normalize(cfg.harness)
  }
  const meta = await sessionMeta(input.sessionId)
  if (!meta?.directory) return undefined
  const hit = await resolveWorkspace({
    directory: meta.directory,
  })
  if (!hit) return undefined
  const cfg = getSessionConfig(hit.id, input.sessionId)
  return cfg?.harness ? normalize(cfg.harness) : undefined
}

export async function resolveHarnessForRequest(input: Input = {}): Promise<SessionHarness> {
  const saved = await sessionHarness(input)
  if (saved) return saved
  await loadUserConfig()
  throw new HarnessSelectionRequiredError()
}

export class HarnessSelectionRequiredError extends Error {
  readonly code = "harness_selection_required"

  constructor() {
    super("An explicit harness selection is required")
    this.name = "HarnessSelectionRequiredError"
  }
}

export async function resolveHarnessHostForRequest(_input: Input = {}): Promise<HarnessHost> {
  return "workspace"
}
