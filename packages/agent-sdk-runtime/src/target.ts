import path from "path"

let id: string | undefined

function clean(dir: string): string {
  return path.resolve(dir.trim())
}

export function workspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CLAXEDO_WR_DIRECTORY ?? process.cwd()
  if (raw.includes(",")) {
    throw new Error("CLAXEDO_WR_DIRECTORY must contain exactly one directory")
  }
  return clean(raw)
}

export function workspaceId(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAXEDO_WR_WORKSPACE_ID) return env.CLAXEDO_WR_WORKSPACE_ID
  if (env !== process.env) return crypto.randomUUID()
  id ??= crypto.randomUUID()
  return id
}

export function assertTarget(requested: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const dir = workspaceDir(env)
  if (!requested) return dir
  if (clean(requested) === dir) return dir
  throw new Error(`workspace-runtime is pinned to ${dir}`)
}

export function requireWorkspaceDirectory(requested: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (!requested) throw new Error("workspace directory is required")
  if (!env.CLAXEDO_WR_DIRECTORY) return clean(requested)
  return assertTarget(requested, env)
}
