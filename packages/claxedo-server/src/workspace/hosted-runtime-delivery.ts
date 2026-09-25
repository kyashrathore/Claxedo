import type { SandboxDriver, SandboxManager } from "@claxedo/sandbox-manager"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { UserAgentConfigRepository } from "@claxedo/server-core/agent-config/repository"
import { userAgentConfigStore } from "@claxedo/server-core/agent-config/repository"
import { explicitDefaultHarness } from "@claxedo/server-core/agent-config/connections"
import { builtInProviderRow } from "@claxedo/server-core/credentials/built-in-destinations"
import {
  nativeProviderAuth,
  nativeProviderDeliveriesFromRepository,
  nativeProviderSecrets,
} from "@claxedo/server-core/credentials/native-delivery-plan"
import type { ControlPlaneCredentials, ControlPlaneServices } from "../authority/services"
import type { WorkspaceRuntimeContext, WorkspaceRuntimePreparation } from "./route-support"
import { hostedRuntimeFetch } from "./hosted-runtime-fetch"

export function createHostedRuntimeDelivery(input: {
  authority: WorkspaceAuthority
  services: ControlPlaneServices
  sandboxManager: SandboxManager
  driver: SandboxDriver
  settings: UserAgentConfigRepository
  credentials(orgId: string): ControlPlaneCredentials
}) {
  const owner = async (workspaceId: string) => {
    const person = await input.authority.resolveWorkspaceOwner?.(workspaceId)
    if (!person) throw new Error(`workspace ${workspaceId} has no active owner`)
    return person
  }
  const deliveries = async (orgId: string) => {
    const credentials = input.credentials(orgId)
    const selected = (await credentials.listCredentials())
      .filter((credential) => (credential.kind === "api_key" || credential.kind === "oauth_token")
        && !!builtInProviderRow(credential.provider_id))
      .map((credential) => ({ credential, ...(credential.status !== "available" ? { unavailable: credential.status } : {}) }))
    return nativeProviderDeliveriesFromRepository({
      selected,
      readSecret: (credential) => credentials.resolveCredentialSecret?.(credential.id) ?? Promise.resolve(null),
      secretBrokering: input.driver.metadata.secretBrokering,
    })
  }
  const snapshot = async (workspaceId: string) => {
    const person = await owner(workspaceId)
    const config = await userAgentConfigStore(input.settings, person.userId).read()
    return {
      version: 4 as const,
      mcp: {},
      connections: Object.values(config.connections),
      ...(explicitDefaultHarness(config) ? { defaultHarness: explicitDefaultHarness(config) } : {}),
      auth: nativeProviderAuth(await deliveries(person.orgId)),
    }
  }
  const push = async (workspaceId: string) => {
    const person = await owner(workspaceId)
    const response = await hostedRuntimeFetch(
      input.services,
      workspaceId,
      person,
      "/api/wr/config",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await snapshot(workspaceId)) },
    )
    if (!response.ok) throw new Error(`hosted runtime config push failed: ${response.status} ${await response.text()}`)
  }
  const prepare = async ({ workspaceId }: WorkspaceRuntimeContext): Promise<WorkspaceRuntimePreparation> => {
    const person = await owner(workspaceId)
    return { secrets: nativeProviderSecrets(await deliveries(person.orgId)) }
  }
  const running = async (predicate: (person: Awaited<ReturnType<typeof owner>>) => boolean) => {
    const leases = await input.sandboxManager.list()
    const workspaces = await Promise.all(leases.filter((lease) => lease.status === "ready").map(async (lease) => {
      const person = await input.authority.resolveWorkspaceOwner?.(lease.workspaceId)
      return person && predicate(person) ? lease.workspaceId : undefined
    }))
    return workspaces.filter((workspaceId): workspaceId is string => !!workspaceId)
  }
  return {
    prepareRuntime: prepare,
    provisionRuntime: async ({ workspaceId }: WorkspaceRuntimeContext) => push(workspaceId),
    settingsChanged: async (userId: string) => {
      await Promise.all((await running((person) => person.userId === userId)).map(push))
    },
    reconcileCredentialDelivery: async (orgId: string) => {
      await Promise.all((await running((person) => person.orgId === orgId)).map(async (workspaceId) => {
        const next = await prepare({ workspaceId })
        const target = await input.sandboxManager.target(workspaceId)
        if (target.status !== "ready") return
        const ensured = await input.sandboxManager.ensure(workspaceId, {
          homeRegion: target.homeRegion,
          secrets: next.secrets,
        })
        if (ensured.status !== "ready") throw new Error(`hosted credential reconcile failed: ${ensured.status}`)
        await push(workspaceId)
      }))
    },
  }
}
