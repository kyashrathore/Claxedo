import type { SandboxEnsureResult, SandboxTargetResult } from "@claxedo/sandbox-manager"
import { timed } from "../platform/http/server-timing"

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

export type ReadySandboxTarget = Extract<SandboxTargetResult, { status: "ready" }>

/** Begins or joins the start of a workspace's sandbox and answers at once; the work itself runs elsewhere. */
export type SandboxStart = (workspaceId: string) => Promise<SandboxStartAnswer>

/** The run a workspace's sandbox start has in flight, as its pollers see it, or nothing when no run is in flight. */
export type SandboxInFlight = (workspaceId: string) => Promise<SandboxStartAnswer | undefined>

/** The steps of a start, for whoever owns its schedule: the lease, then the driver until the lease settles. */
export type SandboxStartDrive = {
  acquire(workspaceId: string): Promise<SandboxStartAnswer>
  provision(workspaceId: string, epoch: number): Promise<SandboxStartAnswer>
  target(workspaceId: string): Promise<SandboxTargetResult>
  /** The ready target whose runtime answers right now; nothing while the lease is ready in the store but its sandbox sleeps or is gone. */
  live(workspaceId: string): Promise<ReadySandboxTarget | undefined>
}

export type SandboxProvisionerStub = {
  /** A connect: answers a live sandbox at once, joins the run in flight, or begins the run the lease needs. */
  start(workspaceId: string): Promise<SandboxStartAnswer>
  /** A re-delivery of what the sandbox runs with: begins or joins a run even for a sandbox that is live. */
  refresh(workspaceId: string): Promise<SandboxStartAnswer>
  /** The run in flight, which a read answers instead of asking a runtime the run is replacing; begins nothing. */
  inFlight(): Promise<SandboxStartAnswer | undefined>
}

export interface SandboxProvisionerNamespace {
  idFromName(name: string): unknown
  get(id: unknown): SandboxProvisionerStub
}

/** The one provisioner a workspace's sandbox starts run under; its calls are the request's Durable Object time. */
export function sandboxProvisioner(namespace: SandboxProvisionerNamespace, workspaceId: string): SandboxProvisionerStub {
  const stub = namespace.get(namespace.idFromName(`workspace:${workspaceId}`))
  return {
    start: (id) => timed("do", () => stub.start(id)),
    refresh: (id) => timed("do", () => stub.refresh(id)),
    inFlight: () => timed("do", () => stub.inFlight()),
  }
}
