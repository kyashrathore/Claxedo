import { HARNESS_TABLE } from "@claxedo/agent-runtime-contract"
import type { AttachInput, DraftLaunch, StartInput } from "../../contract"
import { selectedProviderProjection } from "../../contract"
import { TransportError } from "../../contract/errors"

export type CursorCredential = { apiKey: string; backendUrl?: string; key: string; bound: boolean; ownerLogin: boolean }

export function cursorCredential(input: StartInput | AttachInput | DraftLaunch, env: NodeJS.ProcessEnv): CursorCredential {
  const projection = selectedProviderProjection(input.credentials, HARNESS_TABLE.cursor.providerIds)
  if (projection && "unavailable" in projection) throw new TransportError("cursor", "configuration", `Cursor account unavailable: ${projection.reason}`)
  const ownerLogin = input.credentials.machineLoginAllowed
  const apiKey = projection?.placeholder ?? (ownerLogin ? env.CURSOR_API_KEY?.trim() : undefined)
  if (!apiKey) throw new TransportError("cursor", "configuration", "Cursor SDK requires an API key")
  return { apiKey, bound: projection !== undefined, ownerLogin, ...(projection ? { backendUrl: projection.baseUrl } : {}),
    key: projection?.baseUrl ?? `owner:${env.CURSOR_BACKEND_URL ?? "default"}` }
}
