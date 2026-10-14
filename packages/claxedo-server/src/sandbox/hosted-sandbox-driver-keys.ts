import type { D1Database } from "@cloudflare/workers-types"
import type { SandboxDriverID } from "@claxedo/sandbox-contract"
import { sandboxDriverCatalog } from "@claxedo/sandbox-manager/driver-catalog"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { harnessSecretDelivery } from "@claxedo/server-core/credentials/reach"
import { asRecord, stringField } from "@claxedo/server-core/platform/json/index"
import type { HostedSandboxDriverKeys } from "../credentials/worker/routes"
import { d1OrgSandboxDriver } from "./stores/d1-org-driver"

/** The organization's sandbox provider keys on a D1 plane: org rows in the shared store, the choice on the `orgs` row. */
export function hostedSandboxDriverKeys(input: {
  database: D1Database
  authority: Pick<WorkspaceAuthority, "usersMe">
  drivers: readonly SandboxDriverID[]
  /** Whether this plane brokers for a driver without a provider edge, which decides what its accounts report as reachable. */
  hostedBroker: boolean
  now?: () => number
}): HostedSandboxDriverKeys {
  const store = d1OrgSandboxDriver(input.database, input.now)
  const person = async (auth: SignedControlPlaneAuth) => {
    const userId = stringField(asRecord(await input.authority.usersMe(auth)), "user_id")
    if (!userId) throw new Error("The signed caller has no application user")
    return userId
  }
  return {
    drivers: input.drivers,
    administers: async (auth, orgId) => await store.administers(await person(auth), orgId),
    chosen: store.chosen,
    choose: async (auth, orgId, driver) => {
      if (!await store.choose(await person(auth), orgId, driver)) {
        throw new Error("The organization's sandbox provider changed hands before it could be chosen")
      }
    },
    remove: async (auth, orgId, keyId) => await store.remove(await person(auth), orgId, keyId),
    brokering: (driver) => harnessSecretDelivery(sandboxDriverCatalog[driver].metadata.secretBrokering, input.hostedBroker),
    machineClasses: (driver) => sandboxDriverCatalog[driver].metadata.machineClasses,
  }
}
