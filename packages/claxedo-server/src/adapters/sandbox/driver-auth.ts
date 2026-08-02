import { cleanString as clean } from "../../lib/strings"
import { getCredentialByProvider, resolveSecret } from "../credentials/registry"
import {
  sandboxDriverAuth,
  sandboxDriverCatalog,
  type SandboxDriverAuth,
  type SandboxDriverConfig,
  type SandboxDriverID,
} from "@claxedo/sandbox-manager/driver-catalog"


function json(secret: string) {
  try {
    return JSON.parse(secret) as Record<string, unknown>
  } catch {
    return
  }
}

export function hasManagedSandboxDriverAuth(id: SandboxDriverID) {
  return !!getCredentialByProvider(id, "sandbox_driver")
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
  if (!secret) return
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
// in `routes/sandbox-driver-routes.ts` is the encoder.
//
// This was seven hand-written per-driver branches, and it had already drifted
// from the encoder: both named special cases, but not the SAME ones, so exe.dev
// and Box decoded a JSON blob as though it were a bare token. Driving both
// halves off `credentialFields` removes the class of bug — a new driver needs
// no edit here, and there is no per-driver list left to disagree about.
function parseManagedAuth<T extends SandboxDriverID>(id: T, secret: string): SandboxDriverAuth[T] | undefined {
  const fields = sandboxDriverCatalog[id].credentialFields
  const parsed = json(secret)

  const values =
    parsed
      ? Object.fromEntries(
          fields.flatMap((field) => {
            const raw = parsed[field.key]
            const value = typeof raw === "string" ? clean(raw) : undefined
            return value ? [[field.key, value]] : []
          }),
        )
      : // Legacy bare secret: the pre-codec encoder stored daytona/docker
        // unwrapped, and `credentials/migrate.ts` still writes daytona that
        // way. A bare string can only ever be a single-field driver's value.
        singleFieldLegacyValues(fields, secret)

  if (Object.keys(values).length !== fields.length) return
  return values as SandboxDriverAuth[T]
}

function singleFieldLegacyValues(
  fields: readonly { key: string }[],
  secret: string,
): Record<string, string> {
  if (fields.length !== 1) return {}
  const value = clean(secret)
  return value ? { [fields[0]!.key]: value } : {}
}
