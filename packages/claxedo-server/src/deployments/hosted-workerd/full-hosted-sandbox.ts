import type { D1Database } from "@cloudflare/workers-types"
import type { SandboxDriver } from "@claxedo/sandbox-manager"
import type { ControlPlaneServices } from "../../authority/services"
import type { HostedSandboxBinding } from "../../authority/provider-neutral-hosted-services"
import { createD1SandboxPassRegister } from "../../platform/auth/d1-sandbox-pass-register"
import { createD1SandboxLeaseStore } from "../../sandbox/stores/d1"
import { d1OrgSandboxDriver } from "../../sandbox/stores/d1-org-driver"
import type { HostedSandboxKeys } from "../../sandbox/org-sandbox-drivers"
import { createSessionRowsPasses, type SessionRowsPasses } from "../../session/session-rows-pass"
import { createHostedRuntimeFetch } from "../../workspace/relay-runtime-client"
import { sandboxProvisioner, type SandboxProvisionerNamespace } from "../../workspace/sandbox-start"

/**
 * The full-hosted entry's sandbox and its runtimes' session rows pass, wired
 * into one composition: the pass reads the lease store the sandbox manager
 * writes, delivers through the composed control plane's relay to the runtime
 * that composition provisions, and is admitted by that plane's ingest.
 */
export function composeWithCloudSandbox<Composed extends { plane: { services: ControlPlaneServices } }>(
  input: {
    database: D1Database
    signingEnv: Record<string, string | undefined>
    driver: SandboxDriver
    provisioner: SandboxProvisionerNamespace
    keyDrivers: Omit<HostedSandboxKeys, "chosenDriver">
  },
  compose: (extra: { sandbox: HostedSandboxBinding; sessionRowsPasses: SessionRowsPasses }) => Composed,
): Composed {
  const leaseStore = createD1SandboxLeaseStore({ database: input.database })
  let composed: Composed | undefined
  const services = () => {
    if (!composed) throw new Error("the control plane is not composed yet")
    return composed.plane.services
  }
  const sessionRowsPasses = createSessionRowsPasses({
    signingEnv: input.signingEnv,
    passes: createD1SandboxPassRegister({ database: input.database }),
    leases: leaseStore,
    workspaceOwner: async (workspaceId) => await services().authority?.resolveWorkspaceOwner?.(workspaceId),
    runtimeFetch: (workspaceId, orgId, path, init) => createHostedRuntimeFetch(services())(workspaceId, orgId, path, init),
  })
  composed = compose({
    sandbox: {
      driver: input.driver,
      leaseStore,
      start: (workspaceId) => sandboxProvisioner(input.provisioner, workspaceId).start(workspaceId),
      refresh: (workspaceId) => sandboxProvisioner(input.provisioner, workspaceId).refresh(workspaceId),
      inFlight: (workspaceId) => sandboxProvisioner(input.provisioner, workspaceId).inFlight(),
      deliverSessionRowsPass: sessionRowsPasses.deliver,
      keys: { ...input.keyDrivers, chosenDriver: d1OrgSandboxDriver(input.database).chosen },
    },
    sessionRowsPasses,
  })
  return composed
}
