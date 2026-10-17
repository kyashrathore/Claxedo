import type { WorkspaceIdleStop } from "../workspace/routes/checkpoints"
import type { SandboxProvisionerNamespace, SandboxStart, SandboxStartDrive } from "../workspace/sandbox-start"

/** The idle stop a composition test hands a delivery whose sandboxes it never watches. */
export const unusedWorkspaceIdleStop: WorkspaceIdleStop = async () => {
  throw new Error("this test composed no idle stop")
}

/** A start that runs its lease step and one driver step inside the caller, which is how a Node test watches a driver through the route. */
export function inlineSandboxStart(drive: SandboxStartDrive): SandboxStart {
  return async (workspaceId, request) => {
    const admitted = await drive.acquire(workspaceId, request?.capabilities)
    return admitted.status === "provisioning" ? drive.provision(workspaceId, admitted.epoch, request?.capabilities) : admitted
  }
}

/** The start a composition test hands a sandbox binding whose starts it never begins. */
export const unusedSandboxStart: SandboxStart = async () => {
  throw new Error("this test composed no sandbox start drive")
}

/** The settings push a composition test hands a delivery whose sandboxes it never re-delivers. */
export const unusedSandboxRedeliver = async (): Promise<void> => {
  throw new Error("this test composed no sandbox redelivery")
}

/** The sandbox binding a composition test hands over when it never starts a sandbox. */
export const unusedSandboxStarts = { start: unusedSandboxStart, refresh: unusedSandboxStart, redeliver: unusedSandboxRedeliver, inFlight: async () => undefined } as const

/** The provisioner namespace a Node test composes the full-hosted sandbox with; its starts run inline over `drive`. */
export function inlineSandboxProvisioner(drive?: SandboxStartDrive): SandboxProvisionerNamespace {
  const start = drive ? inlineSandboxStart(drive) : unusedSandboxStart
  const redeliver = async (workspaceId: string) => {
    if (drive) await drive.renew(workspaceId)
  }
  return { idFromName: (name) => name, get: () => ({ start, refresh: start, redeliver, inFlight: async () => undefined }) }
}
