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

// Decoder half of the sandbox-driver credential codec; `sandboxDriverManagedSecret`
// in `sandbox-driver-routes.ts` is the encoder. Both halves read the driver's
// `credentialFields`, so there is no per-driver list for them to disagree about.
function parseManagedAuth<T extends SandboxDriverID>(id: T, secret: string): SandboxDriverAuth[T] | undefined {
  const fields = sandboxDriverCredentialFields[id]
  const parsed = parseJsonRecord(secret)

  const values =
    parsed
      ? Object.fromEntries(
          fields.flatMap((field) => {
            const raw = parsed[field.key]
            const value = typeof raw === "string" ? trimToUndefined(raw) : undefined
            return value ? [[field.key, value]] : []
          }),
        )
      : // Legacy bare secret: the pre-codec encoder stored single-field drivers
        // unwrapped. A bare string can only ever be a single-field driver's value.
        singleFieldLegacyValues(fields, secret)

  if (Object.keys(values).length !== fields.length) return undefined
  if (id === "cloudflare") values.worker_url = cloudflareWorkerBaseUrl(values.worker_url)
  return values as SandboxDriverAuth[T]
}

function singleFieldLegacyValues(
  fields: readonly { key: string }[],
  secret: string,
): Record<string, string> {
  if (fields.length !== 1) return {}
  const value = trimToUndefined(secret)
  return value ? { [fields[0].key]: value } : {}
}
