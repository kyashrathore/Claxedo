import { anyApi } from "convex/server"
import type { ActiveSandboxLeaseCounter } from "../../workspace/runtime-token-guards"

import { requireExecutor, requireServiceToken } from "../../authority/adapters/convex/workspace-authority/executor"
import { recordSandboxLeaseTenant } from "../../authority/adapters/convex/usage-ledger"
import { emitSandboxLeaseOpened } from "../../platform/telemetry/product/metering"
import { productIdentity } from "../../platform/telemetry/product/product"
import type { HostedWorkspaceRouteOptions } from "./workspace"

const leaseApi = anyApi as unknown as {
  sandboxLeases: { countActiveForOrg: unknown }
}

export const convexActiveSandboxLeaseCounter: ActiveSandboxLeaseCounter = async ({ orgId, ownerSubject }) => {
  try {
    const executor = requireExecutor({}, undefined, { allowUnsigned: true })
    const result = await executor.query(leaseApi.sandboxLeases.countActiveForOrg, {
      ...(orgId ? { org_id: orgId } : {}),
      ...(ownerSubject ? { owner_subject: ownerSubject } : {}),
      service_token: requireServiceToken(),
    })
    const active = result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>).active
      : undefined
    return typeof active === "number" ? active : undefined
  } catch {
    return undefined
  }
}

export const convexHostedSandboxUsage = {
  leaseOpened(input) {
    emitSandboxLeaseOpened({
      identity: productIdentity(input.auth, { surface: "workspace", deployment_mode: "cloud" }),
      sink: input.services?.telemetry,
      lease: {
        workspace_id: input.workspaceId,
        driver: input.driver,
        started_at: input.startedAt,
      },
      systemReason: "workspace_create_without_org_claim",
    })
  },
  async recordLeaseTenant(input) {
    const identity = productIdentity(input.auth, { surface: "workspace", deployment_mode: "cloud" })
    await recordSandboxLeaseTenant({
      workspace_id: input.workspaceId,
      owner_subject: input.auth.user.subject,
      ...(identity ? { metering: { org_id: identity.org_id, user_id: identity.user_id } } : {}),
    })
  },
} satisfies NonNullable<HostedWorkspaceRouteOptions["sandboxUsage"]>
