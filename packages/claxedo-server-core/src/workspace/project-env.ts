/**
 * The environment a project's cloud sandboxes start with: what a body may set.
 *
 * Names are shell variable names; the size caps keep a `.env` in the range a
 * sandbox provider accepts as process environment.
 */
export const PROJECT_ENV_MAX_ENTRIES = 64
export const PROJECT_ENV_MAX_BYTES = 32 * 1024
const PROJECT_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Why an `env` body is unacceptable, or `undefined` when it is fine. */
export function projectEnvProblem(env: Record<string, string> | undefined): string | undefined {
  if (!env) return undefined
  const entries = Object.entries(env)
  if (entries.length > PROJECT_ENV_MAX_ENTRIES) return `env has more than ${PROJECT_ENV_MAX_ENTRIES} entries`
  let bytes = 0
  for (const [name, value] of entries) {
    if (typeof value !== "string") return `env value for "${name}" is not a string`
    if (!PROJECT_ENV_NAME.test(name)) return `env name "${name}" is not a valid variable name`
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value)
  }
  if (bytes > PROJECT_ENV_MAX_BYTES) return `env exceeds ${PROJECT_ENV_MAX_BYTES} bytes`
  return undefined
}
