import fs from "fs/promises"
import path from "path"
import { readFileIfExists, writeFileAtomic } from "./fs-safe"
import type { PackageInstallSource } from "./source"
import type { HarnessTarget } from "./manifest"

export type AgentExtensionScope = "project" | "workspace" | "machine"
export type MaterializedAgentExtensionScope = Exclude<AgentExtensionScope, "workspace">

export type DesiredExtensionInstall = {
  id: string
  package_name: string
  source: PackageInstallSource
  scope: AgentExtensionScope
  enabled: boolean
  targets: HarnessTarget[]
  installed_at: number
  updated_at: number
}

export type DesiredExtensionState = {
  version: 1
  installs: DesiredExtensionInstall[]
}

export class AgentExtensionStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentExtensionStateError"
  }
}

export function agentExtensionStateRoot(input: {
  scope: AgentExtensionScope
  projectDir?: string
  workspaceId?: string
  dataRoot?: string
}) {
  if (input.scope === "project") {
    if (!input.projectDir) throw new AgentExtensionStateError("projectDir is required for project Agent Extension state")
    return path.join(input.projectDir, ".agent-extensions")
  }
  if (input.scope === "workspace") {
    if (!input.workspaceId) throw new AgentExtensionStateError("workspaceId is required for workspace Agent Extension state")
    if (!input.dataRoot) throw new AgentExtensionStateError("dataRoot is required for workspace Agent Extension state")
    return path.join(input.dataRoot, "agent-extensions", "workspaces", input.workspaceId)
  }
  if (!input.dataRoot) throw new AgentExtensionStateError("dataRoot is required for machine Agent Extension state")
  return path.join(input.dataRoot, "agent-extensions")
}

export function installedStatePath(input: {
  scope: AgentExtensionScope
  projectDir?: string
  workspaceId?: string
  dataRoot?: string
}) {
  return path.join(agentExtensionStateRoot(input), "installed.json")
}

function sortedInstall(input: DesiredExtensionInstall): DesiredExtensionInstall {
  return {
    ...input,
    targets: [...input.targets].sort(),
  }
}

function sortedState(input: DesiredExtensionState): DesiredExtensionState {
  return {
    version: 1,
    installs: input.installs.map(sortedInstall).sort((a, b) => a.id.localeCompare(b.id)),
  }
}

export function encodeDesiredState(input: DesiredExtensionState) {
  return JSON.stringify(sortedState(input), null, 2) + "\n"
}

export async function readDesiredExtensionState(file: string): Promise<DesiredExtensionState> {
  const raw = await readFileIfExists(file)
  if (raw === undefined) return { version: 1, installs: [] }
  let data: Partial<DesiredExtensionState>
  try {
    data = JSON.parse(raw) as Partial<DesiredExtensionState>
  } catch (err) {
    throw new AgentExtensionStateError(
      `Agent Extension state file ${file} is not valid JSON; fix or remove it (treating it as empty would uninstall every recorded extension): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return sortedState({
    version: 1,
    installs: Array.isArray(data.installs) ? data.installs as DesiredExtensionInstall[] : [],
  })
}

export async function writeDesiredExtensionState(file: string, state: DesiredExtensionState) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 })
  await writeFileAtomic(file, encodeDesiredState(state))
}

export async function upsertDesiredExtensionInstall(file: string, install: DesiredExtensionInstall) {
  const current = await readDesiredExtensionState(file)
  await writeDesiredExtensionState(file, {
    version: 1,
    installs: [...current.installs.filter((item) => item.id !== install.id), install],
  })
}

export async function removeDesiredExtensionInstall(file: string, id: string) {
  const current = await readDesiredExtensionState(file)
  await writeDesiredExtensionState(file, {
    version: 1,
    installs: current.installs.filter((item) => item.id !== id),
  })
}

export async function setDesiredExtensionEnabled(file: string, id: string, enabled: boolean, updatedAt = Date.now()) {
  const current = await readDesiredExtensionState(file)
  await writeDesiredExtensionState(file, {
    version: 1,
    installs: current.installs.map((item) => item.id === id ? {
      ...item,
      enabled,
      updated_at: updatedAt,
    } : item),
  })
}
