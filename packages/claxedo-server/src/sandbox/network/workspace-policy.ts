/**
 * The egress policy one workspace's sandbox boots with.
 *
 * Two sources, one resolution: the rows a user wrote for the workspace, and
 * the model-provider hosts implied by the credentials the fanout will actually
 * send that sandbox. The second source is derived per boot and never stored —
 * a credential is an account, not a standing authorization for every workspace
 * on the deployment.
 */

import { listPolicies } from "@claxedo/server-core/sandbox/network/policy"
import { DEFAULT_ALLOWLIST, PROVIDER_TO_GROUP } from "@claxedo/server-core/sandbox/network/types"
import { selectCredentialsForScope } from "@claxedo/server-core/credentials/registry"
import { resolveSandboxNetworkPolicy, type PolicyEntry, type SandboxNetworkPolicy } from "./resolve"

/** The allowlist groups behind the credentials one org's sandboxes receive. */
export function sharedCredentialGroups(org?: string): PolicyEntry[] {
  const targets = new Set<string>()
  for (const credential of selectCredentialsForScope("shared", org)) {
    const group = PROVIDER_TO_GROUP[credential.provider_id]
    if (group && DEFAULT_ALLOWLIST[group]) targets.add(group)
  }
  return [...targets].map((target) => ({ target, kind: "group" }))
}

/**
 * Resolve the workspace's policy, or nothing when it has no rows of its own.
 *
 * Nothing means allow-all downstream, so credential groups are added to a
 * restriction the user asked for rather than becoming the reason one starts.
 */
export async function resolveWorkspaceSandboxNetworkPolicy(input: {
  workspaceId: string
  org?: string
  serverUrl?: string
}): Promise<SandboxNetworkPolicy | undefined> {
  const rows = listPolicies(input.workspaceId)
  if (rows.length === 0) return undefined
  return await resolveSandboxNetworkPolicy(
    [...rows.map((row) => ({ target: row.target, kind: row.kind })), ...sharedCredentialGroups(input.org)],
    input.serverUrl,
  )
}
