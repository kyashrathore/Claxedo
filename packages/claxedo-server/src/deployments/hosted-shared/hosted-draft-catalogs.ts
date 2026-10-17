import type { CredentialSnapshot } from "@claxedo/agent-runtime-contract"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { UsageProjectionLedger } from "@claxedo/server-core/usage/ledger"
import type { HostedControlPlane } from "../../authority/hosted-services"
import { hostedMachineHarnessLaunch } from "../../credentials/worker/native-launch"
import { hostedOpenCodeCredentials } from "../../credentials/worker/opencode"
import { hostedPiCredentials } from "../../credentials/worker/pi"
import { hostedDraftCredentials, hostedRuntimeProviderCatalog } from "../../routes/hosted/shell"

export function hostedDraftCatalogs(plane: HostedControlPlane, input: {
  draftCredentials?: (workspaceId: string) => Promise<CredentialSnapshot | undefined>
  latestHarnessModel?: UsageProjectionLedger["latestHarnessModel"]
}) {
  const { services } = plane
  const resolveOrgId = (auth: SignedControlPlaneAuth) => requireAuthority(services).resolveOrgId(auth)
  return {
    ...(input.draftCredentials ? { draftCredentials: hostedDraftCredentials(services, input.draftCredentials) } : {}),
    ...hostedOpenCodeCredentials({ resolveOrgId, credentials: plane.orgCredentials, runtimeProviders: hostedRuntimeProviderCatalog(services) }),
    ...hostedPiCredentials({ resolveOrgId, credentials: plane.orgCredentials, ...(input.latestHarnessModel ? { latestHarnessModel: input.latestHarnessModel } : {}) }),
    ...hostedMachineHarnessLaunch({
      resolveOrgId,
      credentials: plane.orgCredentials,
      runtimeReady: async (workspaceId) => (await services.sandbox.sandboxManager?.target(workspaceId))?.status === "ready",
    }),
  }
}
