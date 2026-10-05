import {
  effectiveSandboxDriver,
  sandboxDriverCredentialFields,
  sandboxDriverLabels,
  sandboxDriverSecret,
  type SandboxDriverID,
  type SandboxProvisionerID,
  type SandboxSecretBrokering,
} from "@claxedo/sandbox-contract"
import { parseJsonRecord } from "@claxedo/server-core/platform/json/index"
import type { CredentialMetadata, CredentialWrite } from "../types"

export type SandboxDriverKeyContext = { org: string; person: string; localOperator: boolean }

/** A removed key, a key that was already gone, or the number of workspaces still on it, which keeps it. */
export type SandboxKeyRemoval = { deleted: boolean } | { workspaces: number }

/**
 * How one host keeps sandbox provider keys. A hosted plane keeps the
 * organization's keys (owner `null`) beside a deployment-managed driver; a
 * local machine keeps the person's own. The key is spent only by the sandbox
 * manager, which is why these rows never join the account listings a harness
 * runs on.
 */
export type SandboxDriverKeys = {
  drivers: readonly SandboxDriverID[]
  owner: "org" | "person"
  managed?: SandboxProvisionerID
  canManage: (request: Request, context: SandboxDriverKeyContext) => Promise<boolean>
  chosenDriver: (context: SandboxDriverKeyContext) => Promise<string | undefined>
  chooseDriver: (request: Request, context: SandboxDriverKeyContext, driver: SandboxDriverID | undefined) => Promise<void>
  /**
   * Present on a host whose workspaces record the key their machine was made
   * on: a key is removed only while none of them still uses it, since their
   * stop and destroy need it.
   */
  removeKey?: (request: Request, context: SandboxDriverKeyContext, keyId: string) => Promise<SandboxKeyRemoval>
  /** Whether a driver keeps a delivered secret out of its sandbox; absent where the host cannot tell. */
  brokering?: (driver: SandboxProvisionerID) => SandboxSecretBrokering | undefined
}

function keyOwner(keys: SandboxDriverKeys, context: SandboxDriverKeyContext) {
  return keys.owner === "org" ? null : context.person
}

function keyDriver(keys: SandboxDriverKeys, providerId: string) {
  return keys.drivers.find((id) => id === providerId)
}

const REFUSED_HEALTH: ReadonlySet<string> = new Set(["auth_failed", "no_billing", "expired"])

/** A key the provider has not refused: a rate cap or an unreachable check leaves it in use. */
export function usableSandboxKey(row: CredentialMetadata) {
  return row.status !== "revoked" && row.status !== "expired" && !REFUSED_HEALTH.has(row.health ?? "")
}

export function isSandboxKey(keys: SandboxDriverKeys, row: CredentialMetadata, context: SandboxDriverKeyContext) {
  return row.kind === "sandbox_driver" && row.owner === keyOwner(keys, context) && keyDriver(keys, row.provider_id) !== undefined
}

export function sandboxKeyWrite(
  keys: SandboxDriverKeys,
  context: SandboxDriverKeyContext,
  input: { provider_id: string; secret: string; label?: string },
): CredentialWrite | undefined {
  const id = keyDriver(keys, input.provider_id)
  const fields = parseJsonRecord(input.secret)
  const secret = id && fields ? sandboxDriverSecret(id, fields) : undefined
  if (!id || !secret) return undefined
  return {
    owner: keyOwner(keys, context),
    provider_id: id,
    kind: "sandbox_driver",
    source: "managed",
    label: input.label?.trim() || sandboxDriverLabels[id],
    secret,
  }
}

export function storedSandboxKeys(keys: SandboxDriverKeys, rows: readonly CredentialMetadata[], context: SandboxDriverKeyContext) {
  return rows.filter((row) => isSandboxKey(keys, row, context)).sort((left, right) => left.created_at - right.created_at)
}

async function newWorkspaceDriver(keys: SandboxDriverKeys, rows: readonly CredentialMetadata[], context: SandboxDriverKeyContext) {
  const keyed = storedSandboxKeys(keys, rows, context).flatMap((row) => {
    const id = usableSandboxKey(row) ? keyDriver(keys, row.provider_id) : undefined
    return id ? [id] : []
  })
  return effectiveSandboxDriver({ chosen: await keys.chosenDriver(context), keyed, managed: keys.managed })
}

/** How the driver new cloud workspaces get treats a delivered secret. */
export async function newWorkspaceBrokering(keys: SandboxDriverKeys, rows: readonly CredentialMetadata[], context: SandboxDriverKeyContext) {
  const driver = await newWorkspaceDriver(keys, rows, context)
  return driver ? keys.brokering?.(driver) : undefined
}

export async function sandboxKeyListing<Row>(
  keys: SandboxDriverKeys,
  rows: readonly CredentialMetadata[],
  context: SandboxDriverKeyContext,
  options: { canManage: boolean; redact: (row: CredentialMetadata) => Row },
) {
  const stored = storedSandboxKeys(keys, rows, context)
  return {
    drivers: keys.drivers.map((id) => ({ id, label: sandboxDriverLabels[id], fields: sandboxDriverCredentialFields[id] })),
    default_driver: await newWorkspaceDriver(keys, rows, context) ?? null,
    managed_driver: keys.managed ?? null,
    keys: options.canManage ? stored.map(options.redact) : [],
    can_manage: options.canManage,
  }
}

export function chosenSandboxKey(keys: SandboxDriverKeys, rows: readonly CredentialMetadata[], context: SandboxDriverKeyContext, driver: string) {
  return storedSandboxKeys(keys, rows, context).find((row) => row.provider_id === driver)
}
