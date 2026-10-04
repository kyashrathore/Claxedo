import { isSandboxRuntimeStartPhase, type SandboxPhaseTiming, type SandboxRuntimeStartPhase } from "@claxedo/sandbox-contract"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import { asRecord } from "@claxedo/server-core/platform/json/index"
import { RUNTIME_START_PHASES_PATH } from "../hosts/workspace-runtime/boot-contract"

type RuntimeFetch = (path: string, init: RequestInit) => Promise<Response>

const duration = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0

function report(body: unknown) {
  const record = asRecord(body)
  const phases = (Array.isArray(record?.phases) ? record.phases : [])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is SandboxPhaseTiming<SandboxRuntimeStartPhase> =>
      isSandboxRuntimeStartPhase(entry?.phase) && duration(entry?.durationMs))
    .map(({ phase, durationMs }) => ({ phase, durationMs }))
  const repoSizeBytes = duration(record?.repoSizeBytes) ? record.repoSizeBytes : undefined
  return { phases, ...(repoSizeBytes === undefined ? {} : { repoSizeBytes }) }
}

/**
 * Takes the phases a ready runtime timed inside its sandbox and records them
 * into its lease epoch's start. The runtime hands them over once per boot.
 */
export async function recordRuntimeStartPhases(input: { sandboxManager: SandboxManager; workspaceId: string; runtimeFetch: RuntimeFetch }) {
  const target = await input.sandboxManager.target(input.workspaceId)
  if (target.status !== "ready") return
  const response = await input.runtimeFetch(RUNTIME_START_PHASES_PATH, { method: "POST" })
  if (!response.ok) throw new Error(`the runtime answered ${response.status} for its start phases`)
  const taken = report(await response.json())
  if (taken.phases.length) await input.sandboxManager.recordStartPhases(input.workspaceId, { epoch: target.epoch, ...taken })
}
