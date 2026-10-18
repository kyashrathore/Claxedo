import { isHarnessId, type HarnessId } from "@claxedo/agent-runtime-contract"
import { CredentialSelectionError, noAccountChosen, sessionAccountCredentials } from "@claxedo/harness/registry"
import type { Context } from "hono"
import type { ControlPlaneCredentials } from "@claxedo/server-core/authority/control-plane-contract"
import { LOCAL_USER_ID } from "@claxedo/server-core/platform/auth/local-identity"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import { CursorModelsError, harnessModelAccount, harnessModelList, storedAccountToken } from "../harness-model-list"
import { deliverableRows, spentAccounts } from "../native-delivery-plan"

export type HarnessModelsReader = {
  store: ControlPlaneCredentials
  org: string
  person: string
  /** Whether this host runs the harnesses and the caller is its operator, so a harness with no stored account runs on the CLI's own login. */
  machineLogin: boolean
  fetch?: typeof fetch
}

/**
 * The account the person runs `harness` on, through the same walk and
 * selection a draft's accounts go through, over the rows this host spends
 * (the local scope on the machine the harnesses run on, the sandboxes'
 * otherwise). Reads no secret.
 */
async function personHarnessAccount(reader: HarnessModelsReader, harness: HarnessId) {
  const { store, org, machineLogin } = reader
  if (!store.effectiveCredentials) throw new Error("This host does not report the accounts it spends")
  const [rows, selections] = await Promise.all([store.effectiveCredentials(machineLogin ? "local" : "shared", org), store.accountSelections(org)])
  const snapshot = await spentAccounts({ owner: reader.person, machineOwnerUserId: LOCAL_USER_ID, selections, selected: deliverableRows(rows) })
  const credentials = sessionAccountCredentials(
    { ...snapshot, placement: machineLogin ? "desktop" : "cloud", canUseOwnLogin: machineLogin, leaseGeneration: "settings" },
    { kind: "person", userId: reader.person },
    { harness: { id: harness, access: "native" } },
  )
  const account = harnessModelAccount(credentials, harness)
  if (!account) throw noAccountChosen()
  return account
}

export async function harnessModelsResponse(c: Context, reader: HarnessModelsReader) {
  const harness = c.req.query("nativeHarness") ?? ""
  if (!isHarnessId(harness)) return c.json(errorBody("harness_models_unsupported", "nativeHarness must be claude, codex or cursor"), 400)
  try {
    const list = await harnessModelList({
      harness,
      account: await personHarnessAccount(reader, harness),
      cursorToken: (credentialId) => storedAccountToken(reader.store, credentialId, reader.org),
      ...(reader.fetch ? { fetch: reader.fetch } : {}),
    })
    if (!list) return c.json(errorBody("cursor_account_missing", "Cursor's model list is read with a stored Cursor API key, and none is chosen. Add one in Settings → Models."), 409)
    return c.json(list)
  } catch (error) {
    if (error instanceof CredentialSelectionError) {
      return c.json(errorBody(error.code, error.message, { retryable: error.retryable, ...(error.detail.reason ? { reason: error.detail.reason } : {}) }), 409)
    }
    if (error instanceof CursorModelsError) return c.json(errorBody(error.code, error.message), 502)
    throw error
  }
}
