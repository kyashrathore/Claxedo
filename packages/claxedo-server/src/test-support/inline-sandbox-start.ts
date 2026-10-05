import type { SandboxProvisionerNamespace, SandboxStart, SandboxStartDrive } from "../workspace/sandbox-start"

/** A start that runs its lease step and one driver step inside the caller, which is how a Node test watches a driver through the route. */
export function inlineSandboxStart(drive: SandboxStartDrive): SandboxStart {
  return async (workspaceId) => {
    const admitted = await drive.acquire(workspaceId)
    return admitted.status === "provisioning" ? drive.provision(workspaceId, admitted.epoch) : admitted
  }
}

/** The start a composition test hands a sandbox binding whose starts it never begins. */
export const unusedSandboxStart: SandboxStart = async () => {
  throw new Error("this test composed no sandbox start drive")
}

/** The provisioner namespace a Node test composes the full-hosted sandbox with; its starts run inline over `drive`. */
export function inlineSandboxProvisioner(drive?: SandboxStartDrive): SandboxProvisionerNamespace {
  const start = drive ? inlineSandboxStart(drive) : unusedSandboxStart
  return { idFromName: (name) => name, get: () => ({ start }) }
}
