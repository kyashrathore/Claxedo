import type { SandboxEnsureResult, SandboxTargetResult } from "@claxedo/sandbox-manager"
import { timed } from "../platform/http/server-timing"

/**
 * What a cloud workspace's start answers. The sandbox manager's own answers
 * pass through; `opened` marks the start whose acquire created the
 * workspace's first lease, `joined` a poll answered from the run already in
 * flight with no step of its own, `renewAt` says when a ready sandbox's
 * delivered placeholders must be delivered again, `watchAt` when its idleness
 * is first read because its host reads none, `failure` is the error of the
 * last step the run is retrying, and `failed` is a runtime preparation or
 * settings delivery that refused the start before or after the sandbox.
 */
export type SandboxStartAnswer =
  | (Extract<SandboxEnsureResult, { status: "ready" }> & { renewAt?: number; watchAt?: number })
  | Extract<SandboxEnsureResult, { status: "unavailable" }>
  | (Extract<SandboxEnsureResult, { status: "provisioning" }> & { opened?: true; joined?: true; failure?: string })
  | { status: "failed"; code: "runtime_prepare_failed" | "runtime_provision_failed"; message: string }

export type ReadySandboxTarget = Extract<SandboxTargetResult, { status: "ready" }>

/** Begins or joins the start of a workspace's sandbox and answers at once; the work itself runs elsewhere. */
export type SandboxStart = (workspaceId: string) => Promise<SandboxStartAnswer>

/** The run a workspace's sandbox start has in flight, as its pollers see it, or nothing when no run is in flight. */
export type SandboxInFlight = (workspaceId: string) => Promise<SandboxStartAnswer | undefined>

/** The steps of a start, for whoever owns its schedule: the lease, then the driver until the lease settles. */
export type SandboxStartDrive = {
  acquire(workspaceId: string): Promise<SandboxStartAnswer>
  /** One driver step at `epoch`; a step that retries a failed attempt runs on the fresh epoch its answer names. */
  provision(workspaceId: string, epoch: number): Promise<SandboxStartAnswer>
  target(workspaceId: string): Promise<SandboxTargetResult>
  /** The ready target whose runtime answers right now; nothing while the lease is ready in the store but its sandbox sleeps or is gone. */
  live(workspaceId: string): Promise<ReadySandboxTarget | undefined>
  /** Delivers a serving sandbox its settings again and answers the next time they are due; nothing when the sandbox is not serving. */
  renew(workspaceId: string): Promise<number | undefined>
  /**
   * Reads a serving sandbox's idleness, stops it once the idle policy says so,
   * and answers the next time to read; nothing once the sandbox no longer
   * serves. `failures` counts the reads in a row before this one that threw.
   */
  watch(workspaceId: string, failures: number): Promise<number | undefined>
  /** Sends the telemetry a step queued, inside the Durable Object invocation that ran it; no request flushes a step for it. */
  flushTelemetry?(): Promise<void>
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
