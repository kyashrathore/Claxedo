import { effectiveSandboxDriver, type SandboxDriverID } from "@claxedo/sandbox-contract"
import type { SandboxDriver } from "@claxedo/sandbox-manager"
import type { CredentialMetadata } from "@claxedo/server-core/credentials/types"
import { jsonStringEntries } from "@claxedo/server-core/platform/runtime/lib/json"
import { parseJsonRecord } from "@claxedo/server-core/platform/json/index"
import { usableSandboxKey } from "@claxedo/server-core/credentials/routes/sandbox-driver-keys"
import type { ControlPlaneCredentials } from "../authority/services"

export const OPERATOR_SANDBOX_KEY = "operator"

/** The drivers a full-hosted deployment can build from an organization's key, and where it reads the organization's choice. */
export type HostedSandboxKeys = {
  drivers: readonly SandboxDriverID[]
  create: (id: SandboxDriverID, fields: Record<string, string>) => SandboxDriver | undefined
  chosenDriver: (orgId: string) => Promise<string | undefined>
}

/** A driver and the key it spends: the operator's, or one organization credential at one revision. */
export type SandboxKeyBinding = { key: string; revision: number; driver: SandboxDriver }

export type OrgSandboxDrivers = ReturnType<typeof orgSandboxDrivers>

export function orgSandboxDrivers(input: {
  operator: SandboxDriver
  keys: HostedSandboxKeys
  credentials: (orgId: string) => ControlPlaneCredentials
}) {
  const operator: SandboxKeyBinding = { key: OPERATOR_SANDBOX_KEY, revision: 0, driver: input.operator }
  const driverOf = (row: CredentialMetadata) => input.keys.drivers.find((id) => id === row.provider_id)
  const orgKeys = async (orgId: string) =>
    (await input.credentials(orgId).listCredentials())
      .filter((row) => row.owner === null && row.kind === "sandbox_driver" && driverOf(row) !== undefined)
      .sort((left, right) => left.created_at - right.created_at)
  const built = new Map<string, SandboxKeyBinding>()
  const bind = async (orgId: string, row: CredentialMetadata): Promise<SandboxKeyBinding> => {
    const cached = built.get(row.id)
    if (cached?.revision === row.revision) return cached
    const id = driverOf(row)
    const secret = await input.credentials(orgId).resolveCredentialSecretById?.(row.id)
    const fields = secret ? parseJsonRecord(secret) : undefined
    const driver = id && fields ? input.keys.create(id, jsonStringEntries(fields)) : undefined
    if (!driver) throw new Error(`The organization's ${row.provider_id} sandbox provider key cannot build a driver`)
    const binding = { key: row.id, revision: row.revision, driver }
    built.set(row.id, binding)
    return binding
  }
  return {
    operator,
    async forOrg(orgId: string): Promise<SandboxKeyBinding> {
      const available = (await orgKeys(orgId)).filter(usableSandboxKey)
      const keyed = available.flatMap((row) => driverOf(row) ?? [])
      const chosen = effectiveSandboxDriver({ chosen: await input.keys.chosenDriver(orgId), keyed })
      const row = available.find((candidate) => candidate.provider_id === chosen)
      return row ? await bind(orgId, row) : operator
    },
    async forKey(orgId: string, key: string): Promise<SandboxKeyBinding> {
      const row = (await orgKeys(orgId)).find((candidate) => candidate.id === key)
      if (!row) throw new Error("The sandbox provider key this workspace was created with has been removed")
      return await bind(orgId, row)
    },
  }
}
