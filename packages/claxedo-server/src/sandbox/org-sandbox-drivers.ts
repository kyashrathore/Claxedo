import { effectiveSandboxDriver, type SandboxDriverID, type SandboxSecretBrokering } from "@claxedo/sandbox-contract"
import type { SandboxDriver } from "@claxedo/sandbox-manager"
import { sandboxDriverCatalog } from "@claxedo/sandbox-manager/driver-catalog"
import type { CredentialMetadata } from "@claxedo/server-core/credentials/types"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { jsonStringEntries } from "@claxedo/server-core/platform/runtime/lib/json"
import { parseJsonRecord } from "@claxedo/server-core/platform/json/index"
import { usableSandboxKey } from "@claxedo/server-core/credentials/routes/sandbox-driver-keys"
import type { ControlPlaneCredentials } from "../authority/services"

/** The drivers a full-hosted deployment can build from an organization's key, and where it reads the organization's choice. */
export type HostedSandboxKeys = {
  drivers: readonly SandboxDriverID[]
  create: (id: SandboxDriverID, fields: Record<string, string>) => SandboxDriver | undefined
  chosenDriver: (orgId: string) => Promise<string | undefined>
}

/** A driver and the organization credential it spends, at one revision. */
export type SandboxKeyBinding = { key: string; revision: number; driver: SandboxDriver }

/** The organization holds no sandbox provider key a new cloud workspace could start on. */
export class SandboxProviderKeyMissingError extends ClaxedoError<"sandbox_provider_key_missing"> {
  constructor() {
    super({
      code: "sandbox_provider_key_missing",
      status: 409,
      message: "Add a sandbox provider key under Settings → Models before creating a cloud workspace",
    })
  }
}

export type OrgSandboxDrivers = ReturnType<typeof orgSandboxDrivers>

export function orgSandboxDrivers(input: {
  keys: HostedSandboxKeys
  credentials: (orgId: string) => ControlPlaneCredentials
}) {
  const driverOf = (row: CredentialMetadata) => input.keys.drivers.find((id) => id === row.provider_id)
  const orgKeys = async (orgId: string) =>
    (await input.credentials(orgId).listCredentials())
      .filter((row) => row.owner === null && row.kind === "sandbox_driver" && driverOf(row) !== undefined)
      .sort((left, right) => left.created_at - right.created_at)
  const keyRow = async (orgId: string, key: string) => {
    const row = (await orgKeys(orgId)).find((candidate) => candidate.id === key)
    if (!row) throw new Error("The sandbox provider key this workspace was created with has been removed")
    return row
  }
  const built = new Map<string, SandboxKeyBinding>()
  const bind = async (orgId: string, row: CredentialMetadata): Promise<SandboxKeyBinding> => {
    const cached = built.get(row.id)
    if (cached?.revision === row.revision) return cached
    const id = driverOf(row)
    const secret = await input.credentials(orgId).resolveCredentialSecretById?.(row.id)
    const fields = secret ? parseJsonRecord(secret) : undefined
    const created = id && fields ? input.keys.create(id, jsonStringEntries(fields)) : undefined
    if (!created) throw new Error(`The organization's ${row.provider_id} sandbox provider key cannot build a driver`)
    // The lease names this key before the driver is asked, and a key is removed only while no lease names it:
    // reading the key again here refuses a machine on a key removed after this workspace chose it.
    const driver: SandboxDriver = {
      ...created,
      ensureHost: async (ensure) => {
        await keyRow(orgId, row.id)
        return await created.ensureHost(ensure)
      },
    }
    const binding = { key: row.id, revision: row.revision, driver }
    built.set(row.id, binding)
    return binding
  }
  const chosenRow = async (orgId: string) => {
    const available = (await orgKeys(orgId)).filter(usableSandboxKey)
    const keyed = available.flatMap((row) => driverOf(row) ?? [])
    const chosen = effectiveSandboxDriver({ chosen: await input.keys.chosenDriver(orgId), keyed })
    return available.find((candidate) => candidate.provider_id === chosen)
  }
  return {
    async forOrg(orgId: string): Promise<SandboxKeyBinding> {
      const row = await chosenRow(orgId)
      if (!row) throw new SandboxProviderKeyMissingError()
      return await bind(orgId, row)
    },
    async forKey(orgId: string, key: string): Promise<SandboxKeyBinding> {
      return await bind(orgId, await keyRow(orgId, key))
    },
    /**
     * How the driver a key names brokers secrets, from the catalog alone: a read, so a key that cannot build its
     * driver still answers. An organization without a key has nothing that brokers.
     */
    async secretBrokering(orgId: string, key?: string): Promise<SandboxSecretBrokering> {
      const row = key ? await keyRow(orgId, key) : await chosenRow(orgId)
      const id = row ? driverOf(row) : undefined
      return id ? sandboxDriverCatalog[id].metadata.secretBrokering : "none"
    },
  }
}
