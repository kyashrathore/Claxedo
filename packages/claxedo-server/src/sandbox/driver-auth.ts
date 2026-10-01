import { credentialByProvider, resolveSecret } from "@claxedo/server-core/credentials/registry"
import {
  sandboxDriverAuth,
} from "@claxedo/sandbox-manager/driver-catalog"
import { parseJsonRecord } from "@claxedo/server-core/platform/json/index"
import {
  cloudflareWorkerBaseUrl,
  sandboxDriverCredentialFields,
  type SandboxDriverAuth,
  type SandboxDriverConfig,
  type SandboxDriverID,
} from "@claxedo/sandbox-contract"
import { trimToUndefined } from "@claxedo/helpers/string"



export function hasManagedSandboxDriverAuth(id: SandboxDriverID) {
  return !!credentialByProvider(id, { onOutage: "empty", kind: "sandbox_driver", owner: null })
}

export function sandboxDriverAuthSync<T extends SandboxDriverID>(
  cfg: SandboxDriverConfig | undefined,
  id: T,
  env: Record<string, string | undefined> = process.env,
) {
  return sandboxDriverAuth(cfg, id, env)
}

export async function sandboxDriverAuthManaged<T extends SandboxDriverID>(
  id: T,
): Promise<SandboxDriverAuth[T] | undefined> {
  const secret = await resolveSecret(id, "sandbox_driver")
  if (!secret) return undefined
  return parseManagedAuth(id, secret)
}

export async function sandboxDriverAuthAsync<T extends SandboxDriverID>(
  cfg: SandboxDriverConfig | undefined,
  id: T,
  env: Record<string, string | undefined> = process.env,
): Promise<SandboxDriverAuth[T] | undefined> {
  return sandboxDriverAuthSync(cfg, id, env) ?? sandboxDriverAuthManaged(id)
}

function parseManagedAuth<T extends SandboxDriverID>(id: T, secret: string): SandboxDriverAuth[T] | undefined {
  const fields = sandboxDriverCredentialFields[id]
  const parsed = parseJsonRecord(secret)
  if (!parsed) return undefined
  const values = Object.fromEntries(
    fields.flatMap((field) => {
      const raw = parsed[field.key]
      const value = typeof raw === "string" ? trimToUndefined(raw) : undefined
      return value ? [[field.key, value]] : []
    }),
  )

  if (Object.keys(values).length !== fields.length) return undefined
  if (id === "cloudflare") values.worker_url = cloudflareWorkerBaseUrl(values.worker_url)
  return values as SandboxDriverAuth[T]
}
