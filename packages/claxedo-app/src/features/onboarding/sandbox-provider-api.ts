import { api } from "@/platform/api/api"
import { workspaceSandboxDriversUrl } from "./app-ports"

/**
 * The sandbox provider catalog and the in-flow save, so setup can satisfy the
 * provider key without a detour into Settings (plan 2026-07-31-001 §4.3).
 *
 * The control plane speaks "driver"; the user-facing word is "provider".
 */
export type SandboxProviderField = {
  key: string
  label: string
  secret: boolean
}

/**
 * What the server learned by actually trying the key.
 *
 * `unknown` is not a failure and not a transient state to retry past. Modal's
 * control plane is gRPC-only, so it reports can't-check permanently rather than
 * inventing an endpoint — the copy has to read as a settled answer, not as
 * something still loading.
 */
export type SandboxProviderVerification = {
  state: "working" | "broken" | "unknown"
  /** Already a user-facing sentence; render it verbatim. */
  reason?: string
}

export type SandboxProviderOption = {
  id: string
  label: string
  fields: readonly SandboxProviderField[]
  configured: boolean
  isDefault: boolean
  verification?: SandboxProviderVerification
}

export type SandboxProviderCatalog = {
  providers: readonly SandboxProviderOption[]
  defaultProviderId?: string
}

type DriverBody = { default_driver?: unknown; drivers?: unknown }

export type SandboxProviderReader = (url: string) => Promise<DriverBody>
export type SandboxProviderWriter = (url: string, body: unknown) => Promise<DriverBody>

export async function readSandboxProviderCatalog(input: {
  baseUrl?: string
  read?: SandboxProviderReader
}): Promise<SandboxProviderCatalog> {
  const read = input.read ?? ((url: string) => api.get<DriverBody>(url))
  return parseCatalog(await read(workspaceSandboxDriversUrl({ baseUrl: input.baseUrl })))
}

export function parseCatalog(body: DriverBody): SandboxProviderCatalog {
  const defaultProviderId = typeof body.default_driver === "string" ? body.default_driver : undefined
  const drivers = Array.isArray(body.drivers) ? body.drivers : []
  const providers = drivers.flatMap((value): SandboxProviderOption[] => {
    if (!value || typeof value !== "object") return []
    const driver = value as Record<string, unknown>
    if (typeof driver.id !== "string") return []
    const verification = parseVerification(driver.verification)
    return [{
      id: driver.id,
      label: typeof driver.label === "string" ? driver.label : driver.id,
      fields: parseFields(driver.fields),
      configured: driver.configured === true,
      isDefault: defaultProviderId ? driver.id === defaultProviderId : driver.default === true,
      ...(verification ? { verification } : {}),
    }]
  })
  return { providers, ...(defaultProviderId ? { defaultProviderId } : {}) }
}

/**
 * A row from a server that predates the verdict has no `verification` at all,
 * which is different from one that reports `unknown`: the first has nothing to
 * say, the second has said "I could not check". Absent stays absent.
 */
export function parseVerification(value: unknown): SandboxProviderVerification | undefined {
  if (!value || typeof value !== "object") return
  const verification = value as Record<string, unknown>
  const state = verification.state
  if (state !== "working" && state !== "broken" && state !== "unknown") return
  return {
    state,
    ...(typeof verification.reason === "string" && verification.reason ? { reason: verification.reason } : {}),
  }
}

function parseFields(value: unknown): SandboxProviderField[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const field = item as Record<string, unknown>
    if (typeof field.key !== "string") return []
    return [{
      key: field.key,
      label: typeof field.label === "string" ? field.label : field.key,
      secret: field.secret === true,
    }]
  })
}

export type SandboxProviderSaveOutcome =
  | { ok: true; catalog: SandboxProviderCatalog; verification?: SandboxProviderVerification }
  | { ok: false; reason: string }

/**
 * Saving a key for the provider the user just picked is also how they choose
 * it, so `default: true` goes with the credential in one call rather than
 * leaving a configured provider that nothing will use.
 */
export async function saveSandboxProviderKey(input: {
  baseUrl?: string
  providerId: string
  values: Record<string, string>
  write?: SandboxProviderWriter
  authUrl: (input: { baseUrl?: string; driverId: string }) => string
}): Promise<SandboxProviderSaveOutcome> {
  const write = input.write ?? ((url: string, body: unknown) => api.put<DriverBody>(url, body))
  try {
    const body = await write(input.authUrl({ baseUrl: input.baseUrl, driverId: input.providerId }), {
      auth: input.values,
      default: true,
    })
    const verification = parseVerification((body as Record<string, unknown>).verification)
    return { ok: true, catalog: parseCatalog(body), ...(verification ? { verification } : {}) }
  } catch (error) {
    return { ok: false, reason: sandboxProviderFailureCopy(error) }
  }
}

/**
 * Never surface a raw server code — map it to a sentence and a repair action.
 *
 * A rejected key now arrives with the provider's own verdict attached, so that
 * sentence is preferred over anything derived here: the server knows whether
 * the key was malformed, unauthorized, or merely unbilled, and re-deriving from
 * the message text would throw that away and answer more vaguely.
 */
export function sandboxProviderFailureCopy(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error ?? "")
  const structured = structuredReason(raw)
  if (structured) return structured
  const message = raw.toLowerCase()
  if (message.includes("sandbox_driver_credentials_missing") || message.includes("missing")) {
    return "That provider still has no working key. Check the value and save it again."
  }
  if (message.includes("sandbox_driver_unsupported") || message.includes("unsupported")) {
    return "This server doesn't offer that sandbox provider."
  }
  if (message.includes("401") || message.includes("403") || message.includes("unauthor")) {
    return "The provider rejected that key. Check it was copied whole, then save it again."
  }
  if (message.includes("404")) {
    return "This server can't manage sandbox provider keys. Add the key where the server runs."
  }
  return "Couldn't save that key. Try again."
}

/**
 * The rejection body is thrown as its own JSON text, so the reason the server
 * wrote is in there rather than in a status code we would have to interpret.
 */
function structuredReason(raw: string) {
  try {
    const body = JSON.parse(raw) as { error?: { reason?: unknown; data?: { reason?: unknown } } }
    const reason = body.error?.reason ?? body.error?.data?.reason
    return typeof reason === "string" && reason.trim() ? reason : undefined
  } catch {
    return undefined
  }
}

/**
 * Every field must be filled before the server can build a credential — a
 * partial set stores nothing and reports success, so the button gates on this
 * rather than letting the save silently no-op.
 */
export function canSaveSandboxProvider(provider: SandboxProviderOption, values: Record<string, string>) {
  return provider.fields.length > 0
    && provider.fields.every((field) => (values[field.key] ?? "").trim().length > 0)
}
