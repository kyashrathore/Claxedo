import { TransportError } from "../../contract/errors"

export type SecretBindings = { env?: Record<string, string>; headers?: Record<string, string> }

export function configObject(input: unknown, field: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TransportError("provider", "invalid_config", `${field} must be an object`)
  return Object.fromEntries(Object.entries(input))
}

export function onlyFields(row: Record<string, unknown>, fields: readonly string[], field: string): void {
  const extra = Object.keys(row).find((key) => !fields.includes(key))
  if (extra) throw new TransportError("provider", "invalid_config", `${field} cannot include ${extra}`)
}

export function configText(input: unknown, field: string): string {
  if (typeof input !== "string" || !input.trim()) throw new TransportError("provider", "invalid_config", `${field} must be a non-empty string`)
  return input
}

export function configStringArray(input: unknown, field: string): string[] | undefined {
  if (input === undefined) return undefined
  if (!Array.isArray(input) || input.some((item) => typeof item !== "string")) throw new TransportError("provider", "invalid_config", `${field} must be a string array`)
  return [...input]
}

export function configStringRecord(input: unknown, field: string): Record<string, string> | undefined {
  if (input === undefined) return undefined
  const row = configObject(input, field)
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== "string") throw new TransportError("provider", "invalid_config", `${field} must be a string record`)
    result[key] = value
  }
  return result
}

export function secretBindings(input: unknown, mode: "process" | "remote", literals: Readonly<Record<string, string>>): SecretBindings | undefined {
  if (input === undefined) return undefined
  const row = configObject(input, "secretBindings")
  onlyFields(row, ["env", "headers"], "secretBindings")
  const env = bindingRecord(row.env, "secretBindings.env")
  const headers = bindingRecord(row.headers, "secretBindings.headers")
  if (mode === "process" && headers) throw new TransportError("provider", "invalid_config", "process connections cannot bind header secrets")
  if (mode === "remote" && env) throw new TransportError("provider", "invalid_config", "remote connections cannot bind env secrets")
  const chosen = mode === "process" ? env : headers
  if (Object.keys(chosen ?? {}).some((name) => literals[name] !== undefined)) throw new TransportError("provider", "invalid_config", "secret binding cannot overwrite a literal value")
  return env || headers ? { ...(env ? { env } : {}), ...(headers ? { headers } : {}) } : undefined
}

function bindingRecord(input: unknown, field: string): Record<string, string> | undefined {
  const row = configStringRecord(input, field)
  if (row && (!Object.keys(row).length || Object.entries(row).some(([name, value]) => !name || !value))) {
    throw new TransportError("provider", "invalid_config", `${field} must be a non-empty string record`)
  }
  return row
}

export function resolveBindings(bindings: SecretBindings | undefined, secrets: Readonly<Record<string, string>>): Record<string, string> {
  const expected = [...new Set(Object.values(bindings?.env ?? bindings?.headers ?? {}))].sort()
  const received = Object.keys(secrets).sort()
  if (expected.length !== received.length || expected.some((name, index) => name !== received[index]) || Object.values(secrets).some((value) => !value)) {
    throw new TransportError("provider", "connection_unavailable", "Secret lease does not match configured bindings")
  }
  return Object.fromEntries(Object.entries(bindings?.env ?? bindings?.headers ?? {}).map(([target, name]) => [target, secrets[name]!]))
}
