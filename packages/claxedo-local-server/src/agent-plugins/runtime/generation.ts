import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

const GENERATION_ID = /^generation-[0-9]+-[a-f0-9-]+$/

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function errorCode(value: unknown): string | undefined {
  return record(value) && typeof value.code === "string" ? value.code : undefined
}

function generationRevision(generationId: string) {
  if (!GENERATION_ID.test(generationId)) {
    throw new AgentPluginGenerationError("invalid-generation", `Unsafe Agent Plugins generation ID: ${generationId}`)
  }
  const revision = Number(generationId.slice("generation-".length, generationId.indexOf("-", "generation-".length)))
  if (!Number.isSafeInteger(revision)) {
    throw new AgentPluginGenerationError("invalid-generation", `Invalid Agent Plugins generation revision: ${generationId}`)
  }
  return revision
}

export type ActiveAgentPluginGeneration = {
  generationId: string
  revision: number
}

export class AgentPluginGenerationError extends Error {
  constructor(readonly code: "invalid-generation" | "generation-missing", message: string) {
    super(message)
    this.name = "AgentPluginGenerationError"
  }
}

export function agentPluginRuntimeRoot(runtimeRoot: string) {
  return path.join(runtimeRoot, "agent-plugins")
}

export function generationDirectory(runtimeRoot: string, generationId: string) {
  generationRevision(generationId)
  return path.join(agentPluginRuntimeRoot(runtimeRoot), "generations", generationId)
}

export function newGenerationId(revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new AgentPluginGenerationError("invalid-generation", `Invalid Agent Plugins revision: ${revision}`)
  }
  return `generation-${revision}-${randomUUID()}`
}

export async function readActiveGeneration(runtimeRoot: string): Promise<ActiveAgentPluginGeneration | undefined> {
  const file = path.join(agentPluginRuntimeRoot(runtimeRoot), "active.json")
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"))
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined
    throw new AgentPluginGenerationError("invalid-generation", `Agent Plugins active pointer is invalid: ${String(error)}`)
  }
  if (!record(raw)) {
    throw new AgentPluginGenerationError("invalid-generation", "Agent Plugins active pointer must be an object")
  }
  const value = raw
  if (typeof value.generationId !== "string"
    || !GENERATION_ID.test(value.generationId)
    || typeof value.revision !== "number"
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0) {
    throw new AgentPluginGenerationError("invalid-generation", "Agent Plugins active pointer contains unsafe fields")
  }
  if (generationRevision(value.generationId) !== value.revision) {
    throw new AgentPluginGenerationError("invalid-generation", "Agent Plugins active pointer revision does not match its generation ID")
  }
  const root = generationDirectory(runtimeRoot, value.generationId)
  if (!await fs.stat(root).then((item) => item.isDirectory()).catch(() => false)) {
    throw new AgentPluginGenerationError("generation-missing", `Active Agent Plugins generation ${value.generationId} is missing`)
  }
  return { generationId: value.generationId, revision: value.revision }
}

export async function activateGeneration(runtimeRoot: string, generation: ActiveAgentPluginGeneration) {
  if (generationRevision(generation.generationId) !== generation.revision) {
    throw new AgentPluginGenerationError("invalid-generation", "Agent Plugins generation revision does not match its ID")
  }
  const root = generationDirectory(runtimeRoot, generation.generationId)
  if (!await fs.stat(root).then((item) => item.isDirectory()).catch(() => false)) {
    throw new AgentPluginGenerationError("generation-missing", `Cannot activate missing generation ${generation.generationId}`)
  }
  const moduleRoot = agentPluginRuntimeRoot(runtimeRoot)
  await fs.mkdir(moduleRoot, { recursive: true })
  const pending = path.join(moduleRoot, `.active-${randomUUID()}.json`)
  await fs.writeFile(pending, `${JSON.stringify(generation)}\n`, { flag: "wx" })
  try {
    await fs.rename(pending, path.join(moduleRoot, "active.json"))
  } finally {
    await fs.rm(pending, { force: true })
  }
}

export async function cleanupInactiveGenerations(runtimeRoot: string, keep = 1) {
  const active = await readActiveGeneration(runtimeRoot)
  const root = path.join(agentPluginRuntimeRoot(runtimeRoot), "generations")
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const inactive = entries
    .filter((entry) => entry.isDirectory() && GENERATION_ID.test(entry.name) && entry.name !== active?.generationId)
    .map((entry) => entry.name)
    .toSorted((left, right) => generationRevision(left) - generationRevision(right) || left.localeCompare(right))
  const remove = inactive.slice(0, Math.max(0, inactive.length - keep))
  await Promise.all(remove.map((entry) => fs.rm(generationDirectory(runtimeRoot, entry), { recursive: true, force: true })))
}
