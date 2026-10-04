import type { SandboxBrokeredSecret } from "@claxedo/sandbox-manager"
import type { RuntimeConfigSnapshotPlugins } from "@claxedo/harness/contract"
import { isRecord } from "@claxedo/helpers/guards"
import type { AgentPluginRuntimeApplyRequest, AgentPluginRuntimeApplyResponse } from "@claxedo/server-core/agent-plugins/runtime/apply-contract"
import type { WorkspaceRuntimePreparation } from "../../workspace/route-support"
import { agentPluginMcpRuntimePlan } from "../mcp/runtime-preparation"
import type { AgentPluginRuntimeProjectionPlan, SignedAgentPluginRuntimeSnapshot } from "./provision"
import { runtimeMcpServers } from "@claxedo/server-core/agent-plugins/runtime/mcp-projection"

const HARNESS = "pi"

/**
 * The Pi launch a session's own Durable Object runs with: the workspace
 * machine's materialized launch, whose plugin roots the host reads skills
 * from on that machine, with each remote plugin server carrying its gateway
 * credential itself — the host has no provider edge to substitute one — and
 * each machine stdio server named, which the host reaches through the
 * machine by that name alone. A server that needs no credential passes as it
 * is; one whose credential only the machine's provider edge holds is left out.
 * The rows are passed on as read: the host validates them as it validates
 * every harness launch.
 */
export function sessionHostPlugins(input: {
  harnessLaunch: Record<string, Record<string, unknown>>
  mcpServers: AgentPluginRuntimeApplyRequest["mcpServers"]
  secrets: readonly SandboxBrokeredSecret[]
}): RuntimeConfigSnapshotPlugins {
  const launch = input.harnessLaunch[HARNESS]
  if (!launch) return { harnessLaunch: {}, mcp: {} }
  const values = Object.fromEntries(input.secrets.map((secret) => [secret.name, secret.value]))
  const gateway = new Map(runtimeMcpServers(input.mcpServers.filter((row) => row.harnessId === HARNESS), values)
    .flatMap((server) => server.state === "gateway" && server.headers ? [[server.url, server.headers] as const] : []))
  const servers: unknown[] = Array.isArray(launch.mcpServers) ? launch.mcpServers : []
  const mcpServers = servers.flatMap((server): Record<string, unknown>[] => {
    if (!isRecord(server)) return []
    const { kind, name, origin, command, url } = server
    if (kind === "stdio") return [{ kind, name, origin, command }]
    if (typeof url !== "string") return []
    const headers = gateway.get(url)
    if (headers) return [{ kind, name, origin, url, headers }]
    return server.headers === undefined ? [{ kind, name, origin, url }] : []
  })
  return { harnessLaunch: { [HARNESS]: { ...launch, mcpServers } }, mcp: {} }
}

/**
 * The host carries its own gateway credentials, as a signed desktop does, so
 * its preparation is a native one whatever the deployment's driver brokers;
 * the machine is provisioned with the same plan, which at an unchanged
 * revision answers its active generation, so the launch names the roots the
 * host reads skills from.
 */
export function createSessionHostPlugins(input: {
  cloudWorkspace(workspaceId: string): Promise<boolean>
  activations: { runtimeSnapshot(workspaceId: string): Promise<SignedAgentPluginRuntimeSnapshot> }
  preparer: { forSnapshot(snapshot: SignedAgentPluginRuntimeSnapshot, options: { secretBrokering: "native" }): Promise<WorkspaceRuntimePreparation> }
  provisioner: { provision(workspaceId: string, plan: AgentPluginRuntimeProjectionPlan): Promise<AgentPluginRuntimeApplyResponse> }
}) {
  return async (workspaceId: string): Promise<RuntimeConfigSnapshotPlugins> => {
    if (!(await input.cloudWorkspace(workspaceId))) return { harnessLaunch: {}, mcp: {} }
    const preparation = await input.preparer.forSnapshot(await input.activations.runtimeSnapshot(workspaceId), { secretBrokering: "native" })
    const plan = agentPluginMcpRuntimePlan(preparation)
    const receipt = await input.provisioner.provision(workspaceId, plan)
    return sessionHostPlugins({ harnessLaunch: receipt.harnessLaunch, mcpServers: plan.mcpServers, secrets: preparation.secrets ?? [] })
  }
}
