import { api } from "@/platform/api/api"
import { workspaceSandboxDriversUrl } from "./app-ports"

/**
 * Whether cloud workspaces can actually be created right now.
 *
 * The control plane speaks "driver"; the user-facing word is "provider".
 *
 * "Usable" means SOME provider carries credentials, not that the default one
 * does. The default is only a starting suggestion, and a provider can arrive
 * configured without ever being picked — ambient `MODAL_*`/`CLOUDFLARE_*` env
 * vars configure those drivers while `daytona` stays the default. Reading only
 * the default reported "no cloud" on a machine that had two working providers,
 * and stranded setup on a step the user had already satisfied.
 */
export type SandboxProviderStatus = {
  configured: boolean
  providerId?: string
  providerLabel?: string
}

type DriverResponse = {
  default_driver?: unknown
  drivers?: unknown
}

export type SandboxDriverReader = (url: string) => Promise<DriverResponse>

export async function readSandboxProviderStatus(input: {
  baseUrl?: string
  read?: SandboxDriverReader
}): Promise<SandboxProviderStatus> {
  const read: SandboxDriverReader = input.read ?? ((url) => api.get<DriverResponse>(url))
  const data = await read(workspaceSandboxDriversUrl({ baseUrl: input.baseUrl }))
  const drivers = Array.isArray(data.drivers) ? data.drivers : []
  const defaultDriver = typeof data.default_driver === "string" ? data.default_driver : undefined
  const configured = drivers.flatMap((value) => {
    if (!value || typeof value !== "object") return []
    const driver = value as Record<string, unknown>
    if (typeof driver.id !== "string" || driver.configured !== true) return []
    return [
      {
        id: driver.id,
        label: typeof driver.label === "string" ? driver.label : driver.id,
        isDefault: defaultDriver ? driver.id === defaultDriver : driver.default === true,
      },
    ]
  })

  // The default one when it works, otherwise whichever does — that is the one
  // a workspace would actually be created on.
  const active = configured.find((driver) => driver.isDefault) ?? configured[0]
  if (!active) return { configured: false }
  return { configured: true, providerId: active.id, providerLabel: active.label }
}

export function sandboxProviderQueryOptions(input: {
  baseUrl?: string
  serverUrl: string
  read?: SandboxDriverReader
}) {
  return {
    queryKey: ["claxedo", "onboarding", "sandbox-provider", input.serverUrl] as const,
    queryFn: () => readSandboxProviderStatus({ baseUrl: input.baseUrl, read: input.read }),
    // A missing or unreachable sandbox route means no cloud — not an error the
    // user needs to see during setup.
    retry: false,
  }
}
