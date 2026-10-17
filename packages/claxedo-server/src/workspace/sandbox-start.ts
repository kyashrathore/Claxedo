import type { SandboxEnsureResult, SandboxTargetResult } from "@claxedo/sandbox-manager"
import { timed } from "../platform/http/server-timing"
import type { AgentPluginExecutionSelection } from "@claxedo/server-core/agent-plugins/runtime/execution-selection"
import type { WorkspaceRuntimeContext } from "./route-support"
import type { MachineNotice } from "./machine-notice"

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

/** When a serving sandbox's settings are next due, and when its idleness is first read. */
export type SandboxFollowUps = { renewAt?: number; watchAt?: number }

export type ReadySandboxTarget = Extract<SandboxTargetResult, { status: "ready" }>

/**
 * `retry` is a person asking again after a start failed: the failure held for
 * that start's connects does not answer it. `capabilities` is a Task root's
 * own capability set, which this start and every later step of the workspace
 * is prepared with.
 */
export type SandboxStartRequest = { retry?: true; capabilities?: AgentPluginExecutionSelection }

/** Begins or joins the start of a workspace's sandbox and answers at once; the work itself runs elsewhere. */
export type SandboxStart = (workspaceId: string, request?: SandboxStartRequest) => Promise<SandboxStartAnswer>

/** The run a workspace's sandbox start has in flight, as its pollers see it, or nothing when no run is in flight. */
export type SandboxInFlight = (workspaceId: string) => Promise<SandboxStartAnswer | undefined>

/** The steps of a start, for whoever owns its schedule: the lease, then the driver until the lease settles. */
export type SandboxStartDrive = {
  acquire(workspaceId: string, capabilities?: AgentPluginExecutionSelection): Promise<SandboxStartAnswer>
  /** One driver step at `epoch`; a step that retries a failed attempt runs on the fresh epoch its answer names. */
  provision(workspaceId: string, epoch: number, capabilities?: AgentPluginExecutionSelection): Promise<SandboxStartAnswer>
  target(workspaceId: string): Promise<SandboxTargetResult>
  /** The ready target whose runtime answers right now; nothing while the lease is ready in the store but its sandbox sleeps or is gone. */
  live(workspaceId: string): Promise<ReadySandboxTarget | undefined>
  /** Delivers a serving sandbox its settings again and answers the next time they are due; nothing when the sandbox is not serving. */
  renew(workspaceId: string, capabilities?: AgentPluginExecutionSelection): Promise<number | undefined>
  /**
   * Reads a serving sandbox's idleness, stops it once the idle policy says so,
   * and answers the next time to read; nothing once the sandbox no longer
   * serves. `failures` counts the reads in a row before this one that threw.
   */
  watch(workspaceId: string, failures: number): Promise<number | undefined>
  /** Sends the telemetry a step queued, inside the Durable Object invocation that ran it; no request flushes a step for it. */
  flushTelemetry?(): Promise<void>
  /** Tells the workspace owner's open clients that a start began or settled, whoever asked for it. */
  announce?: MachineNotice
}

export type SandboxProvisionerStub = {
  /** A connect: answers a live sandbox at once, joins the run in flight, is told the last start's held failure, or begins the run the lease needs. */
  start(workspaceId: string, request?: SandboxStartRequest): Promise<SandboxStartAnswer>
  /** A re-delivery of what the sandbox runs with: begins or joins a run even for a sandbox that is live. */
  refresh(workspaceId: string): Promise<SandboxStartAnswer>
  /** A settings push to a serving sandbox with no driver step and no run; a run in flight delivers them as it settles. */
  redeliver(workspaceId: string): Promise<void>
  /**
   * Takes up the follow-ups of a sandbox whose settings were pushed outside a
   * run, as a Task root's are when it is created: they are scheduled as a
   * ready start's are, and every later step of the workspace is prepared with
   * the root's capability set.
   */
  follow(context: WorkspaceRuntimeContext, due: SandboxFollowUps): Promise<void>
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
    start: (id, request) => timed("do", () => stub.start(id, request)),
    refresh: (id) => timed("do", () => stub.refresh(id)),
    redeliver: (id) => timed("do", () => stub.redeliver(id)),
    follow: (context, due) => timed("do", () => stub.follow(context, due)),
    inFlight: () => timed("do", () => stub.inFlight()),
  }
}
