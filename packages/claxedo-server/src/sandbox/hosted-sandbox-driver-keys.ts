import type { D1Database } from "@cloudflare/workers-types"
import type { SandboxDriverID } from "@claxedo/sandbox-contract"
import { sandboxDriverCatalog } from "@claxedo/sandbox-manager/driver-catalog"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { harnessSecretDelivery } from "@claxedo/server-core/credentials/reach"
import type { HostedSandboxDriverKeys } from "../credentials/worker/routes"
import type { SandboxLeaseStore } from "@claxedo/sandbox-manager"
import { liftOrgKeyRetryWaits } from "./org-sandbox-manager"
import { d1OrgSandboxDriver } from "./stores/d1-org-driver"

/** The organization's sandbox provider keys on a D1 plane: org rows in the shared store, the choice on the `orgs` row. */
export function hostedSandboxDriverKeys(input: {
  database: D1Database
  drivers: readonly SandboxDriverID[]
  /** Whether this plane brokers for a driver without a provider edge, which decides what its accounts report as reachable. */
  hostedBroker: boolean
  /** The leases of the plane's cloud workspaces, which record the key each one starts on. */
  leaseStore: SandboxLeaseStore
  now?: () => number
}): HostedSandboxDriverKeys {
  const store = d1OrgSandboxDriver(input.database, input.now)
  /** The signed subject is the application user id, as `hostedOrgAdministers` reads it; the store's write re-checks that this user administers. */
  const person = (auth: SignedControlPlaneAuth) => auth.user.subject
  return {
    drivers: input.drivers,
    chosen: store.chosen,
    choose: async (auth, orgId, driver) => {
      if (!await store.choose(person(auth), orgId, driver)) {
        throw new Error("The organization's sandbox provider changed hands before it could be chosen")
      }
    },
    remove: async (auth, orgId, keyId) => await store.remove(person(auth), orgId, keyId),
    changed: (orgId, keyId) => liftOrgKeyRetryWaits(input.leaseStore, orgId, keyId),
    brokering: (driver) => harnessSecretDelivery(sandboxDriverCatalog[driver].metadata.secretBrokering, input.hostedBroker),
    machineClasses: (driver) => sandboxDriverCatalog[driver].metadata.machineClasses,
  }
}
