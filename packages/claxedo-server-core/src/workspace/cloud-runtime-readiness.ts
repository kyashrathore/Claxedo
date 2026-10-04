import { asRecord, asString } from "@claxedo/helpers/guards"
import type { SandboxManagerPort, SandboxTargetResult } from "../sandbox/manager-port"

export type AuthorityRowBacking = "local-worktree" | "cloud-vm"

/**
 * A row naming no backing is the provisioner's, never the reader's own
 * machine: defaulting the other way would put somebody else's workspace on
 * this one.
 */
export function authorityRowBacking(row: unknown): AuthorityRowBacking {
  return asString(asRecord(row)?.backing) === "local-worktree" ? "local-worktree" : "cloud-vm"
}

function cloudWorkspaceIds(rows: readonly unknown[]) {
  return rows.flatMap((row) => {
    const record = asRecord(row)
    const id = asString(record?.workspace_id) ?? asString(record?.workspaceId)
    return id && authorityRowBacking(row) === "cloud-vm" ? [id] : []
  })
}

export type CloudRuntimeLifecycle =
  | { status: "ready" | "provisioning" | "stopped" }
  | { status: "failed"; error: string }

function lifecycleOf(target: SandboxTargetResult | undefined): CloudRuntimeLifecycle {
  if (!target) return { status: "failed", error: "Cloud runtime is unavailable" }
  if (target.status === "ready") return { status: "ready" }
  if (target.leaseStatus === "acquiring") return { status: "provisioning" }
  if (target.leaseStatus === "stopped" || target.leaseStatus === "destroyed" || target.reason === "runtime_lease_missing") {
    return { status: "stopped" }
  }
  return { status: "failed", error: target.reason }
}

/**
 * Each cloud workspace's lifecycle among authority rows, read from its
 * sandbox lease. `target` reads the lease row alone, so asking never starts
 * compute; a deployment with no sandbox manager runs no sandbox at all.
 */
export async function cloudWorkspaceLifecycles(
  manager: Pick<SandboxManagerPort, "target"> | undefined,
  rows: readonly unknown[],
): Promise<ReadonlyMap<string, CloudRuntimeLifecycle>> {
  return new Map(await Promise.all(
    cloudWorkspaceIds(rows).map(async (id) => [id, lifecycleOf(await manager?.target(id))] as const),
  ))
}

/** The cloud workspaces among authority rows whose sandbox is running now. */
export async function readyCloudWorkspaces(
  manager: Pick<SandboxManagerPort, "target"> | undefined,
  rows: readonly unknown[],
): Promise<ReadonlySet<string>> {
  const lifecycles = await cloudWorkspaceLifecycles(manager, rows)
  return new Set([...lifecycles].flatMap(([id, lifecycle]) => (lifecycle.status === "ready" ? [id] : [])))
}
