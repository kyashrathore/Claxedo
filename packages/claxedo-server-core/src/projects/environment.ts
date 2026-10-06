import type { ControlPlaneCredentials } from "../authority/control-plane-contract"
import { ClaxedoError } from "../platform/errors/base"

/**
 * The size caps keep a project's variables in the range a sandbox provider
 * accepts as process environment.
 */
export const PROJECT_ENV_MAX_ENTRIES = 64
export const PROJECT_ENV_MAX_BYTES = 32 * 1024
const PROJECT_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/**
 * The runtime's own namespaces. A project variable in either would restate
 * what the sandbox composition writes (its identity, source, grants), and the
 * manager refuses such a start as unavailable with no hint which variable did it.
 */
const RUNTIME_NAMESPACE = /^(WORKSPACE_RUNTIME|CLAXEDO)_/i

export class ProjectEnvironmentError extends ClaxedoError {
  constructor(message: string) {
    super({ code: "project_env_invalid", message, status: 400 })
  }
}

export function isProjectEnvName(name: string) {
  return PROJECT_ENV_NAME.test(name)
}

function variablePrefix(projectId: string) {
  return `project-env:${projectId}:`
}

/**
 * A project's variables, one credential row per variable in the
 * deployment's encrypted credential store. The rows belong to no person and
 * carry a namespaced provider id, so no account listing, fanout or delivery
 * of provider credentials ever selects them.
 */
export function projectEnvironment(credentials: ControlPlaneCredentials, org: string) {
  const rows = async (projectId: string) => {
    const prefix = variablePrefix(projectId)
    const found = new Map<string, string>()
    for (const row of await credentials.listCredentials(org)) {
      if (row.owner !== null || !row.provider_id.startsWith(prefix)) continue
      const name = row.provider_id.slice(prefix.length)
      if (isProjectEnvName(name)) found.set(name, row.id)
    }
    return found
  }
  const values = async (projectId: string) => {
    const read = credentials.resolveCredentialSecretById
    if (!read) throw new Error("This credential store cannot read a project's environment")
    const env: Record<string, string> = {}
    for (const [name, id] of await rows(projectId)) {
      const value = await read(id, org)
      if (value !== null) env[name] = value
    }
    return env
  }
  return {
    names: async (projectId: string) => [...(await rows(projectId)).keys()].sort(),
    values,
    async set(projectId: string, name: string, value: string) {
      if (!isProjectEnvName(name)) throw new ProjectEnvironmentError(`"${name}" is not a valid variable name`)
      if (RUNTIME_NAMESPACE.test(name)) throw new ProjectEnvironmentError(`"${name}" is reserved for the workspace runtime`)
      if (!value) throw new ProjectEnvironmentError(`${name} needs a value`)
      const next = { ...(await values(projectId)), [name]: value }
      const entries = Object.entries(next)
      if (entries.length > PROJECT_ENV_MAX_ENTRIES) {
        throw new ProjectEnvironmentError(`A project holds at most ${PROJECT_ENV_MAX_ENTRIES} variables`)
      }
      const bytes = entries.reduce((total, [key, text]) => total + new TextEncoder().encode(key + text).byteLength, 0)
      if (bytes > PROJECT_ENV_MAX_BYTES) throw new ProjectEnvironmentError(`A project's variables exceed ${PROJECT_ENV_MAX_BYTES} bytes`)
      await credentials.putCredential({
        owner: null,
        provider_id: `${variablePrefix(projectId)}${name}`,
        kind: "api_key",
        source: "managed",
        label: name,
        secret: value,
      }, org)
    },
    async remove(projectId: string, name: string) {
      const id = (await rows(projectId)).get(name)
      return id ? await credentials.deleteCredential(id, org) : false
    },
    async clear(projectId: string) {
      for (const id of (await rows(projectId)).values()) await credentials.deleteCredential(id, org)
    },
  }
}

export type ProjectEnvironment = ReturnType<typeof projectEnvironment>
