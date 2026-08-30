import { authorizeWorkspace, type OpenCodeRuntime } from "@claxedo/opencode-runtime"
import { getEffectiveConfig } from "@claxedo/server-core/agent-config/index"

export type McpSyncResult = {
  name: string
  ok: boolean
  status: number
  body?: unknown
  error?: string
}

let runtime: OpenCodeRuntime | undefined
const managed = new Map<string, Set<string>>()

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function configureOpencodeMcpSync(input: { runtime: OpenCodeRuntime }) {
  runtime = input.runtime
}

function configuredRuntime(): OpenCodeRuntime {
  if (!runtime) throw new Error("OpenCode SDK runtime is not configured")
  return runtime
}

function scope(input: { directory: string; workspaceID?: string }) {
  return authorizeWorkspace({ workspaceID: input.workspaceID ?? input.directory, directory: input.directory })
}

export async function opencodeMcpStatus(input: { directory: string; workspaceID?: string }) {
  return configuredRuntime().configuration.mcpStatus(scope(input))
}

export async function connectOpencodeMcp(input: { directory: string; workspaceID?: string; name: string }) {
  return configuredRuntime().configuration.connectMcp(scope(input), input.name)
}

export async function disconnectOpencodeMcp(input: { directory: string; workspaceID?: string; name: string }) {
  return configuredRuntime().configuration.disconnectMcp(scope(input), input.name)
}

export async function syncOpencodeMcpConfig(options?: { directory?: string; workspaceID?: string }) {
  if (!runtime || !options?.directory) return [] as McpSyncResult[]
  const authorized = authorizeWorkspace({
    workspaceID: options.workspaceID ?? options.directory,
    directory: options.directory,
  })
  const desired = record((await getEffectiveConfig()).mcp)
  const previouslyManaged = managed.get(authorized.directory) ?? new Set<string>()
  const status = await runtime.configuration.mcpStatus(authorized)
  const results: McpSyncResult[] = []

  for (const name of previouslyManaged) {
    if (name in desired) continue
    try {
      await runtime.configuration.removeMcp(authorized, name)
      results.push({ name, ok: true, status: 200 })
    } catch (cause) {
      results.push({ name, ok: false, status: 0, error: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  const nextManaged = new Set<string>()
  for (const [name, config] of Object.entries(desired)) {
    try {
      if (name in status) await runtime.configuration.removeMcp(authorized, name)
      const body = await runtime.configuration.addMcp(authorized, name, record(config))
      nextManaged.add(name)
      results.push({ name, ok: true, status: 200, body })
    } catch (cause) {
      results.push({ name, ok: false, status: 0, error: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  managed.set(authorized.directory, nextManaged)
  return results
}

export function mergeSyncedMcpStatus(current: unknown) {
  return record(current)
}
