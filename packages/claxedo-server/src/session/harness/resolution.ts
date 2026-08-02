import type { HarnessHost } from "../../architecture"
import { defaultHarness, loadUserConfig } from "../../agent-config"
import { sessionMeta } from "../meta/meta"
import { getSessionConfig, normalize, type SessionHarness } from "./harness"
import { resolveWorkspace } from "../../workspace/store/store"
import { normalizeHarnessIdentity } from "@claxedo/agent-sdk-runtime"

type Input = {
  type?: string | null
  binary?: string | null
  model?: string | null
  sessionId?: string | null
  workspaceId?: string | null
  directory?: string | null
}

export function parseHarness(input: Pick<Input, "type" | "binary" | "model">) {
  const identity = normalizeHarnessIdentity(input.type ?? undefined)
  if (!identity) return
  return normalize({
    id: identity.id,
    access: identity.access,
    ...(input.binary ? { connection: { kind: "process" as const, binary: input.binary } } : {}),
  } satisfies SessionHarness)
}

async function sessionHarness(input: Pick<Input, "sessionId" | "workspaceId" | "directory">) {
  if (!input.sessionId) return
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
  if (!meta?.directory) return
  const hit = await resolveWorkspace({
    directory: meta.directory,
  })
  if (!hit) return
  const cfg = getSessionConfig(hit.id, input.sessionId)
  if (cfg?.harness) return normalize(cfg.harness)
}

export async function resolveHarnessForRequest(input: Input = {}): Promise<SessionHarness> {
  const saved = await sessionHarness(input)
  if (saved) return saved
  const hit = parseHarness(input)
  if (hit) return hit
  return defaultHarness(await loadUserConfig())
}

export async function resolveHarnessHostForRequest(_input: Input = {}): Promise<HarnessHost> {
  return "workspace"
}
