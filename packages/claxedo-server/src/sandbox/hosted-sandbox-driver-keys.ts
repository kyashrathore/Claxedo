import type { D1Database } from "@cloudflare/workers-types"
import type { SandboxDriverID, SandboxProvisionerID } from "@claxedo/sandbox-contract"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { asRecord, stringField } from "@claxedo/server-core/platform/json/index"
import type { HostedSandboxDriverKeys } from "../credentials/worker/routes"
import { d1OrgSandboxDriver } from "./stores/d1-org-driver"

/** The organization's sandbox provider keys on a D1 plane: org rows in the shared store, the choice on the `orgs` row. */
export function hostedSandboxDriverKeys(input: {
  database: D1Database
  authority: Pick<WorkspaceAuthority, "usersMe">
  drivers: readonly SandboxDriverID[]
  managed: SandboxProvisionerID
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
    managed: input.managed,
    administers: async (auth, orgId) => await store.administers(await person(auth), orgId),
    chosen: store.chosen,
    choose: async (auth, orgId, driver) => {
      if (!await store.choose(await person(auth), orgId, driver)) {
        throw new Error("The organization's sandbox provider changed hands before it could be chosen")
      }
    },
  }
}
