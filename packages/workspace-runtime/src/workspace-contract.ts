/**
 * Workspace Contract — schema and loader for `.claxedo/workspace` and `.claxedo/processes`.
 *
 * `.claxedo/workspace` is authoritative for:
 * - runtime requirements (node, python, bun, system packages)
 * - prepare phase (expensive setup, cacheable into prepared image)
 * - verify phase (health/readiness checks)
 * - compute class
 * - acceleration policy (snapshot, prepared image)
 * - secret and network requirements
 *
 * `.claxedo/processes` is authoritative for:
 * - service definitions, commands, ports, per-service readiness
 * (This extends the existing `.opencode/processes.jsonc` with contract-level authority)
 *
 * Both files are JSONC (JSON with comments).
 */

import { parse as parseJsonc } from "jsonc-parser"
import z from "zod"
import path from "path"
import fs from "fs/promises"

// ── Workspace contract schema ──────────────────────────────────────────

export const RuntimeRequirements = z.object({
  node: z.string().optional(),
  python: z.string().optional(),
  bun: z.string().optional(),
  system_packages: z.array(z.string()).optional(),
})
export type RuntimeRequirements = z.infer<typeof RuntimeRequirements>

export const PhaseStep = z.object({
  name: z.string(),
  command: z.string(),
  timeout_seconds: z.number().int().positive().optional(),
})
export type PhaseStep = z.infer<typeof PhaseStep>

export const ComputeClass = z.enum(["small", "medium", "large", "gpu"])
export type ComputeClass = z.infer<typeof ComputeClass>

export const AccelerationPolicy = z.object({
  snapshot: z.enum(["auto", "manual", "disabled"]).default("auto"),
  prepared_image: z.enum(["auto", "manual", "disabled"]).default("auto"),
})
export type AccelerationPolicy = z.infer<typeof AccelerationPolicy>

export const SecretRequirement = z.object({
  name: z.string(),
  env_var: z.string(),
  description: z.string().optional(),
  required: z.boolean().default(true),
})
export type SecretRequirement = z.infer<typeof SecretRequirement>

export const NetworkRule = z.object({
  target: z.string(),
  kind: z.enum(["host", "domain", "group"]),
  description: z.string().optional(),
})
export type NetworkRule = z.infer<typeof NetworkRule>

export const CacheHint = z.object({
  path: z.string(),
  description: z.string().optional(),
})
export type CacheHint = z.infer<typeof CacheHint>

export const WorkspaceContract = z.object({
  $schema: z.string().optional(),
  source: z.object({
    repo: z.string().optional(),
    branch: z.string().optional(),
    version: z.string().optional(),
  }).optional(),
  runtime: RuntimeRequirements.optional(),
  compute_class: ComputeClass.optional(),
  prepare: z.array(PhaseStep).optional(),
  verify: z.array(PhaseStep).optional(),
  cache: z.array(CacheHint).optional(),
  acceleration: AccelerationPolicy.optional(),
  secrets: z.array(SecretRequirement).optional(),
  network: z.array(NetworkRule).optional(),
})
export type WorkspaceContract = z.infer<typeof WorkspaceContract>

// ── Processes contract schema ──────────────────────────────────────────

export const ServiceReadiness = z.object({
  type: z.enum(["http", "tcp", "command"]),
  target: z.string(),
  interval_seconds: z.number().int().positive().default(5),
  timeout_seconds: z.number().int().positive().default(30),
  retries: z.number().int().min(0).default(10),
})
export type ServiceReadiness = z.infer<typeof ServiceReadiness>

export const ServiceDefinition = z.object({
  name: z.string().min(1),
  command: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  port: z.number().int().positive().optional(),
  auto_start: z.boolean().default(false),
  restart_policy: z.enum(["never", "on-failure", "always"]).default("on-failure"),
  depends_on: z.array(z.string()).optional(),
  readiness: ServiceReadiness.optional(),
})
export type ServiceDefinition = z.infer<typeof ServiceDefinition>

export const ProcessesContract = z.object({
  $schema: z.string().optional(),
  services: z.array(ServiceDefinition),
})
export type ProcessesContract = z.infer<typeof ProcessesContract>

// ── Loader ─────────────────────────────────────────────────────────────

const CONTRACT_DIR = ".claxedo"
const WORKSPACE_FILE = "workspace"
const PROCESSES_FILE = "processes"

async function readJsonc<S extends z.ZodTypeAny>(
  filePath: string,
  schema: S,
): Promise<z.output<S> | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf-8")
    const parsed = parseJsonc(raw)
    return schema.parse(parsed)
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as any).code === "ENOENT") {
      return undefined
    }
    throw err
  }
}

export async function loadWorkspaceContract(directory: string): Promise<WorkspaceContract | undefined> {
  return readJsonc(path.join(directory, CONTRACT_DIR, WORKSPACE_FILE), WorkspaceContract)
}

export async function loadProcessesContract(directory: string): Promise<ProcessesContract | undefined> {
  return readJsonc(path.join(directory, CONTRACT_DIR, PROCESSES_FILE), ProcessesContract)
}

export type LoadedContracts = {
  workspace: WorkspaceContract | undefined
  processes: ProcessesContract | undefined
}

export async function loadContracts(directory: string): Promise<LoadedContracts> {
  const [workspace, processes] = await Promise.all([
    loadWorkspaceContract(directory),
    loadProcessesContract(directory),
  ])
  return { workspace, processes }
}

// ── Contract fingerprinting ────────────────────────────────────────────

/**
 * Compute a stable hash of the workspace contract for cache invalidation.
 * Changes to runtime requirements, prepare steps, or compute class
 * invalidate prepared images and snapshots.
 */
export function contractFingerprint(contract: WorkspaceContract): string {
  const significant = {
    compute_class: contract.compute_class ?? null,
    prepare: contract.prepare ?? null,
    runtime: contract.runtime ?? null,
  }
  // Stable JSON — keys sorted lexicographically via replacer
  const json = JSON.stringify(significant, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
    }
    return value
  })
  // Simple djb2 hash — good enough for cache key comparison
  let hash = 5381
  for (let i = 0; i < json.length; i++) {
    hash = ((hash << 5) + hash + json.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}
