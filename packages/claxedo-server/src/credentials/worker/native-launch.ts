import { isProviderUnavailable, type ProviderBinding } from "@claxedo/agent-runtime-contract"
import type { ResolvedCredentials } from "@claxedo/harness/contract"
import { claudeBundledOptions, codexBundledOptions, cursorAccountOptions, cursorApiModels } from "@claxedo/harness/launch-models"
import { withDeadlineSignal } from "@claxedo/helpers/deadline"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { credentialSecretMaterial } from "@claxedo/server-core/credentials/secret-material"
import type { ControlPlaneCredentials } from "../../authority/services"

const CURSOR_MODELS_URL = "https://api.cursor.com/v1/models"
const CURSOR_REQUEST_TIMEOUT_MS = 10_000

export type MachineHarnessDraft = {
  readonly workspaceId: string
  readonly harness: "claude" | "codex" | "cursor"
  readonly model?: string
  readonly credentials: ResolvedCredentials
}

export class CursorModelsError extends Error {
  readonly code = "cursor_models_unavailable"
}

type DeliveredAccount = { readonly plan: boolean; readonly credentialId: string | undefined }

function deliveredAccount(credentials: ResolvedCredentials): DeliveredAccount | undefined {
  const binding = Object.values(credentials.providers).find((row): row is ProviderBinding => !isProviderUnavailable(row))
  if (binding) return { plan: binding.authMode === "bearer", credentialId: binding.account?.credentialId }
  const direct = Object.values(credentials.direct ?? {})[0]
  return direct && { plan: direct.authKind === "subscription", credentialId: direct.account?.credentialId }
}

async function readCursorModels(token: string, fetcher: typeof fetch) {
  const response = await withDeadlineSignal(CURSOR_REQUEST_TIMEOUT_MS, (signal) =>
    fetcher(CURSOR_MODELS_URL, { headers: { authorization: `Bearer ${token}` }, signal })).catch((cause: unknown) => {
    throw new CursorModelsError("Cursor's model list could not be reached.", { cause })
  })
  if (!response.ok) throw new CursorModelsError(`Cursor refused the model list read (${response.status}).`)
  return cursorApiModels(await response.json())
}

/**
 * A machine harness's models while its workspace's runtime is not up, so a
 * draft picks one without waking the sandbox: Claude Code's and Codex's are
 * generated from the versions the sandbox runs, Cursor's are its account's
 * own list from Cursor's API. A ready runtime answers with its own instead.
 */
export function hostedMachineHarnessLaunch(input: {
  resolveOrgId(auth: SignedControlPlaneAuth): Promise<string>
  credentials: ((orgId: string) => ControlPlaneCredentials) | undefined
  runtimeReady(workspaceId: string): Promise<boolean>
  fetch?: typeof fetch
}) {
  const cursorToken = async (auth: SignedControlPlaneAuth, credentialId: string) => {
    const store = input.credentials?.(await input.resolveOrgId(auth))
    const row = await store?.getCredential?.(credentialId)
    const secret = row && await store?.resolveCredentialSecretById?.(credentialId)
    return row && secret ? credentialSecretMaterial({ kind: row.kind, secret })?.token : undefined
  }
  return {
    machineHarnessLaunch: async (auth: SignedControlPlaneAuth, draft: MachineHarnessDraft) => {
      if (await input.runtimeReady(draft.workspaceId)) return undefined
      const account = deliveredAccount(draft.credentials)
      if (!account) return undefined
      if (draft.harness === "claude") return claudeBundledOptions(account.plan ? "plan" : "api", draft.model)
      if (draft.harness === "codex") return codexBundledOptions(draft.model)
      const token = account.credentialId && await cursorToken(auth, account.credentialId)
      if (!token) return undefined
      return cursorAccountOptions(await readCursorModels(token, input.fetch ?? globalThis.fetch), draft.model)
    },
  }
}
