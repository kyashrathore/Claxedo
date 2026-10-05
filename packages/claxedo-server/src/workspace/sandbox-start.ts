import type { SandboxEnsureResult, SandboxTargetResult } from "@claxedo/sandbox-manager"

/**
 * What a cloud workspace's start answers. The sandbox manager's own answers
 * pass through; `opened` marks the start whose acquire created the
 * workspace's first lease, and `failed` is a runtime preparation or
 * settings delivery that refused the start before or after the sandbox.
 */
export type SandboxStartAnswer =
  | Exclude<SandboxEnsureResult, { status: "provisioning" }>
  | (Extract<SandboxEnsureResult, { status: "provisioning" }> & { opened?: true })
  | { status: "failed"; code: "runtime_prepare_failed" | "runtime_provision_failed"; message: string }

/** Begins or joins the start of a workspace's sandbox and answers at once; the work itself runs elsewhere. */
export type SandboxStart = (workspaceId: string) => Promise<SandboxStartAnswer>

/** The steps of a start, for whoever owns its schedule: the lease, then the driver until the lease settles. */
export type SandboxStartDrive = {
  acquire(workspaceId: string): Promise<SandboxStartAnswer>
  provision(workspaceId: string, epoch: number): Promise<SandboxStartAnswer>
  target(workspaceId: string): Promise<SandboxTargetResult>
}

export type SandboxProvisionerStub = { start(workspaceId: string): Promise<SandboxStartAnswer> }

export interface SandboxProvisionerNamespace {
  idFromName(name: string): unknown
  get(id: unknown): SandboxProvisionerStub
}

/** The one provisioner a workspace's sandbox starts run under. */
export function sandboxProvisioner(namespace: SandboxProvisionerNamespace, workspaceId: string): SandboxProvisionerStub {
  return namespace.get(namespace.idFromName(`workspace:${workspaceId}`))
}
