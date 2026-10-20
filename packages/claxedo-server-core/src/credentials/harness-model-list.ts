import { HARNESS_TABLE, isProviderUnavailable, type HarnessId } from "@claxedo/agent-runtime-contract"
import type { ConfigOptionsPreview, ResolvedCredentials } from "@claxedo/harness/contract"
import { claudeBundledOptions } from "@claxedo/harness/claude-models"
import { codexBundledOptions } from "@claxedo/harness/codex-models"
import { cursorAccountOptions, cursorApiModels } from "@claxedo/harness/cursor-models"
import { withDeadlineSignal } from "@claxedo/helpers/deadline"
import type { ControlPlaneCredentials } from "../authority/control-plane-contract"
import { credentialSecretMaterial } from "./secret-material"

const CURSOR_MODELS_URL = "https://api.cursor.com/v1/models"
const CURSOR_REQUEST_TIMEOUT_MS = 10_000

export class CursorModelsError extends Error {
  readonly code = "cursor_models_unavailable"
}

/**
 * The account a harness runs on, as far as its model list depends on it. A
 * machine login is never asked which form it is, since asking starts the CLI.
 */
export type HarnessModelAccount =
  | { readonly kind: "stored"; readonly plan: boolean; readonly credentialId: string | undefined }
  | { readonly kind: "machineLogin" }

export function harnessModelAccount(credentials: ResolvedCredentials, harness: HarnessId): HarnessModelAccount | undefined {
  const providerIds = HARNESS_TABLE[harness].providerIds
  const binding = providerIds.flatMap((id) => {
    const row = Object.hasOwn(credentials.providers, id) ? credentials.providers[id] : undefined
    return row && !isProviderUnavailable(row) ? [row] : []
  })[0]
  if (binding) return { kind: "stored", plan: binding.authMode === "bearer", credentialId: binding.account?.credentialId }
  const direct = providerIds.flatMap((id) => credentials.direct && Object.hasOwn(credentials.direct, id) ? [credentials.direct[id]] : [])[0]
  if (direct) return { kind: "stored", plan: direct.authKind === "subscription", credentialId: direct.account?.credentialId }
  return credentials.machineLoginAllowed ? { kind: "machineLogin" } : undefined
}

export async function storedAccountToken(store: Pick<ControlPlaneCredentials, "getCredential" | "resolveCredentialSecretById">, credentialId: string, org?: string) {
  const row = await store.getCredential?.(credentialId, org)
  const secret = row && await store.resolveCredentialSecretById?.(credentialId, org)
  return row && secret ? credentialSecretMaterial({ kind: row.kind, secret })?.token : undefined
}

async function fetchCursorAccountModels(token: string, fetcher: typeof fetch) {
  const response = await withDeadlineSignal(CURSOR_REQUEST_TIMEOUT_MS, (signal) =>
    fetcher(CURSOR_MODELS_URL, { headers: { authorization: `Bearer ${token}` }, signal })).catch((cause: unknown) => {
    throw new CursorModelsError("Cursor's model list could not be reached.", { cause })
  })
  if (!response.ok) throw new CursorModelsError(`Cursor refused the model list read (${response.status}).`)
  return cursorApiModels(await response.json())
}

/**
 * A Claude Code, Codex or Cursor model list that starts no CLI and no
 * workspace: Claude Code's and Codex's generated from the versions the server
 * ships (a machine login lists Claude Code's plan form), Cursor's the stored
 * account's own list from Cursor's API. Undefined when Cursor has no stored
 * key to read it with; each caller decides what that means.
 */
export async function harnessModelList(input: {
  harness: HarnessId
  account: HarnessModelAccount
  model?: string
  cursorToken: (credentialId: string) => Promise<string | undefined>
  fetch?: typeof fetch
}): Promise<ConfigOptionsPreview | undefined> {
  const { account } = input
  if (input.harness === "claude") return claudeBundledOptions(account.kind === "stored" && !account.plan ? "api" : "plan", input.model)
  if (input.harness === "codex") return codexBundledOptions(input.model)
  const token = account.kind === "stored" && account.credentialId ? await input.cursorToken(account.credentialId) : undefined
  if (!token) return undefined
  return cursorAccountOptions(await fetchCursorAccountModels(token, input.fetch ?? globalThis.fetch), input.model)
}
