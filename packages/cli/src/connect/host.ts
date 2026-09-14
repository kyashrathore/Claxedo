import fs from "node:fs/promises"
import path from "node:path"
import { createHostConnector, type AssignmentDescription, type HostEndpoints } from "@claxedo/host-connector/connector"
import { DECISION_EXIT_CODE, HostConnectDecisionError } from "@claxedo/host-connector/bootstrap"
import { hostKeyPairFromJwk } from "@claxedo/host-connector/host-identity"
import { effectiveRoots, pathWithinRoots, type HostScope, type HostState, type HostStateStore } from "@claxedo/host-connector/host-state"
import {
  createMachineSignedTransport,
  decisionCode,
  HostedHttpError,
  HostedRequestTimeoutError,
  type FetchLike,
} from "@claxedo/host-connector/machine-transport"
import { createHostRuntimeListener, type HostRuntimeListener, type HostWorkspaceRuntimeOptions } from "@claxedo/host-serving/runtime"
import {
  setUserHostedServing,
  stopUserHostedServing,
  userHostedServingState,
  type UserHostedServingCredential,
} from "@claxedo/host-serving/serving"
import { createWorkspaceOpenCodeRuntime } from "@claxedo/workspace-runtime"
import { asFiniteNumber, asRecordOrEmpty } from "@claxedo/helpers/guards"
import { trimToUndefined } from "@claxedo/helpers/string"
import { errorMessage } from "../json"
import { LEASE_TTL_MS } from "./paths"

/** A runtime's private SDK owner; the listener disposes the runtime, this process closes the owner. */
export type OwnedOpenCodeRuntime = NonNullable<HostWorkspaceRuntimeOptions["opencodeRuntime"]>

export type HostDeps = {
  fetch: FetchLike
  createListener: () => Promise<HostRuntimeListener>
  openCodeRuntime: (directory: string) => OwnedOpenCodeRuntime | undefined
  setServing: typeof setUserHostedServing
  servingState: typeof userHostedServingState
  stopServing: typeof stopUserHostedServing
  resolvePath: (target: string) => Promise<string>
  setInterval: (fn: () => void, ms: number) => { cancel: () => void }
  /** Subscribe to the process's stop request; the returned function unsubscribes. */
  onStopSignal: (fn: (signal: string) => void) => () => void
  now: () => number
  sleep: (ms: number) => Promise<void>
  log: (line: string) => void
  pid: number
}

export function defaultHostDeps(): HostDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    createListener: () => createHostRuntimeListener({ hostname: "127.0.0.1", port: 0 }),
    openCodeRuntime: (directory) => createWorkspaceOpenCodeRuntime(directory),
    setServing: setUserHostedServing,
    servingState: userHostedServingState,
    stopServing: stopUserHostedServing,
    resolvePath: (target) => fs.realpath(target),
    setInterval: (fn, ms) => {
      const handle = setInterval(fn, ms)
      return { cancel: () => clearInterval(handle) }
    },
    onStopSignal: (fn) => {
      const onTerm = () => fn("SIGTERM")
      const onInt = () => fn("SIGINT")
      process.once("SIGTERM", onTerm)
      process.once("SIGINT", onInt)
      return () => {
        process.off("SIGTERM", onTerm)
        process.off("SIGINT", onInt)
      }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
    pid: process.pid,
  }
}

export const BEAT_INTERVAL_MS = Math.min(LEASE_TTL_MS / 3, 20_000)

/**
 * Transport failures are retried until this much wall-clock time has passed
 * since the first attempt, then the process gives up with exit 1. Every
 * request the attempts make is bounded by the transport's own deadline, so
 * the last attempt overruns the budget by at most one request timeout.
 */
export const BOOTSTRAP_RETRY_BUDGET_MS = 5 * 60_000
const RETRY_CAP_MS = 30_000

const DECISION_STATUSES = new Set([400, 401, 403, 404, 409, 410])

/** Whether a failure describes the connection rather than a decision, so a later attempt may outlive it. */
export function transientBootstrapFailure(error: unknown) {
  if (error instanceof HostConnectDecisionError) return false
  if (error instanceof HostedHttpError) return !DECISION_STATUSES.has(error.status)
  if (error instanceof HostedRequestTimeoutError || error instanceof TypeError) return true
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
}

export async function withBootstrapRetry<T>(
  deps: Pick<HostDeps, "sleep" | "now" | "log">,
  label: string,
  attempt: () => Promise<T>,
  transient: (error: unknown) => boolean = transientBootstrapFailure,
): Promise<T> {
  const started = deps.now()
  const deadline = started + BOOTSTRAP_RETRY_BUDGET_MS
  let delay = 1_000
  for (;;) {
    try {
      return await attempt()
    } catch (error) {
      if (!transient(error)) throw error
      const remaining = deadline - deps.now()
      if (remaining <= 0) {
        throw new Error(`${label} failed for ${Math.round((deps.now() - started) / 1000)}s: ${errorMessage(error)}`, { cause: error })
      }
      const wait = Math.min(delay, remaining)
      deps.log(`${label} failed (${errorMessage(error)}); retrying in ${wait / 1000}s`)
      await deps.sleep(wait)
      delay = Math.min(delay * 2, RETRY_CAP_MS)
    }
  }
}

/** `connector.start()` reporting a transport failure on acquire; the connector can be started again. */
class StartFailure extends Error {}

/** The heartbeat ack's `hostTunnel` verbatim from the control plane, or nothing serveable. */
export function servingCredential(tunnel: unknown, fallbackRelayUrl: string | undefined): UserHostedServingCredential | null {
  const row = asRecordOrEmpty(tunnel)
  const hostId = trimToUndefined(row.hostId)
  const token = trimToUndefined(row.hostTunnelToken)
  const expiresAt = asFiniteNumber(row.tokenExpiresAt)
  const relayUrl = trimToUndefined(row.relayUrl) ?? fallbackRelayUrl
  const workspaceIds = Array.isArray(row.workspaceIds)
    ? row.workspaceIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : []
  if (!hostId || !token || !expiresAt || !relayUrl || workspaceIds.length === 0) return null
  return { hostId, relayUrl, token, workspaceIds, expiresAt }
}

function credentialWithout(credential: UserHostedServingCredential | null, workspaceId: string) {
  if (!credential) return null
  const workspaceIds = credential.workspaceIds.filter((id) => id !== workspaceId)
  return workspaceIds.length ? { ...credential, workspaceIds } : null
}

export type HostRunInput = {
  store: HostStateStore
  /** Enrolled; `run` is rewritten by this loop and cleared when it returns. */
  state: HostState
  deps: HostDeps
}

/**
 * Serve until told to stop. Returns the process exit code: 0 after a stop
 * signal drained everything, 78 when the control plane decided against this
 * machine, 1 when the generation could not be acquired within the retry
 * budget.
 */
export async function runHost(input: HostRunInput): Promise<number> {
  const { deps } = input
  let state = input.state
  const enrollment = state.enrollment
  if (!enrollment) throw new Error("runHost needs an enrolled state")
  const keys = await hostKeyPairFromJwk(state.private_key_jwk)
  const transport = createMachineSignedTransport({
    controlPlaneUrl: state.control_plane_url,
    keys,
    enrollmentId: enrollment.enrollment_id,
    hostId: state.host_id,
    keyVersion: enrollment.key_version,
    fetch: deps.fetch,
  })

  // Saves are chained so two beats cannot race their renames; the last
  // state written is the last state computed.
  let saving: Promise<void> = Promise.resolve()
  const persist = (next: HostState) => {
    state = next
    saving = saving.then(() => input.store.save(next)).catch((error: unknown) => {
      deps.log(`could not write host state: ${errorMessage(error)}`)
    })
    return saving
  }

  // A SIGKILLed instance leaves its `run` record behind; this process's own
  // start is what the next record carries, never the dead one's.
  const startedAt = deps.now()
  const listener = await deps.createListener()
  const composition = { localBaseUrl: listener.url, sessionAuthority: () => "managed-private" as const }
  const owned = new Map<string, { directory: string; runtime: OwnedOpenCodeRuntime | undefined }>()
  let credential: UserHostedServingCredential | null = null

  const serve = async (next: UserHostedServingCredential | null) => {
    credential = next
    try {
      await deps.setServing(next, composition)
    } catch (error) {
      deps.log(`relay serving update failed: ${errorMessage(error)}`)
    }
  }

  const retire = async (workspaceId: string) => {
    await serve(credentialWithout(credential, workspaceId))
    await listener.dispose(workspaceId)
    const entry = owned.get(workspaceId)
    owned.delete(workspaceId)
    await entry?.runtime?.close().catch((error: unknown) => {
      deps.log(`workspace ${workspaceId}: SDK runtime close failed: ${errorMessage(error)}`)
    })
  }

  const canonicalRoots = () => effectiveRoots(state, deps.resolvePath)

  const prepare = async (description: AssignmentDescription) => {
    const { workspaceId } = description
    const relay = state.relay
    const authority = state.authority
    if (!relay || !authority) {
      throw new Error("the control plane has not delivered relay and authority endpoints yet")
    }
    const roots = await canonicalRoots()
    const directory = await deps.resolvePath(description.remoteDirectory).catch((error: unknown) => {
      throw new Error(`${description.remoteDirectory} cannot be resolved: ${errorMessage(error)}`)
    })
    if (!pathWithinRoots(directory, roots)) {
      throw new Error(`${description.remoteDirectory} is outside this host's roots (${roots.join(", ") || "none"})`)
    }
    const current = owned.get(workspaceId)
    if (current && current.directory !== directory) await retire(workspaceId)
    else if (current) await serve(credentialWithout(credential, workspaceId))
    const runtime = current?.directory === directory ? current.runtime : deps.openCodeRuntime(directory)
    owned.set(workspaceId, { directory, runtime })
    await listener.ensure({
      workspaceId,
      directory,
      hostId: state.host_id,
      relay: { jwksUrl: relay.jwksUrl },
      sessionAuthorityUrl: authority.sessionAuthorityUrl,
      storeRoot: path.join(state.storage_root, workspaceId),
      ...(runtime ? { opencodeRuntime: runtime } : {}),
    })
  }

  let decided: ((code: number) => void) | undefined
  const decision = new Promise<number>((resolve) => {
    decided = resolve
  })

  const connector = createHostConnector({
    mode: "machine",
    hostId: state.host_id,
    keys,
    transport,
    enrollmentId: enrollment.enrollment_id,
    heartbeatIntervalMs: BEAT_INTERVAL_MS,
    sessionAuthority: "managed-private",
    roots: canonicalRoots,
    resolvePath: deps.resolvePath,
    setInterval: deps.setInterval,
    onScope: (scope: HostScope) => persist({ ...state, scope }),
    onEndpoints: (endpoints: HostEndpoints) =>
      persist({
        ...state,
        ...(endpoints.relay ? { relay: endpoints.relay } : {}),
        ...(endpoints.authority ? { authority: endpoints.authority } : {}),
      }),
    onAssignments: async (descriptions) => {
      const wanted = new Set(descriptions.map((description) => description.workspaceId))
      for (const workspaceId of listener.workspaceIds()) {
        if (wanted.has(workspaceId)) continue
        deps.log(`workspace ${workspaceId}: assignment withdrawn; stopping its runtime`)
        await retire(workspaceId)
      }
      const acked = new Map(connector.acked().map((ack) => [ack.workspaceId, ack.revision]))
      for (const description of descriptions) {
        if (acked.get(description.workspaceId) === description.revision) continue
        try {
          await prepare(description)
          await connector.ack({ workspaceId: description.workspaceId, revision: description.revision })
          deps.log(`workspace ${description.workspaceId}: serving ${description.remoteDirectory} (revision ${description.revision})`)
        } catch (error) {
          deps.log(`workspace ${description.workspaceId}: refused: ${errorMessage(error)}`)
          await retire(description.workspaceId)
        }
      }
    },
    onServing: (tunnel) => {
      void serve(servingCredential(tunnel, state.relay?.url))
    },
    onLeaseRenewed: (renewed) => {
      const serving = deps.servingState(composition)
      const connected = new Set(serving.serving ? serving.connectedWorkspaceIds : [])
      void persist({
        ...state,
        run: {
          pid: deps.pid,
          started_at: startedAt,
          generation: connector.generation() ?? 0,
          last_beat_ok_at: deps.now(),
          lease_expires_at: renewed.enrollment.expires_at,
          served: connector.acked().map((ack) => ({
            workspace_id: ack.workspaceId,
            revision: ack.revision,
            connected: connected.has(ack.workspaceId),
          })),
        },
      })
    },
    onError: (stage, error) => {
      deps.log(`${stage} failed: ${errorMessage(error)}`)
      if (stage !== "heartbeat") return
      void persist({ ...state, ...(state.run ? { run: { ...state.run, last_beat_error: errorMessage(error) } } : {}) })
      // `stop` runs right after this callback; the state is read once it has.
      queueMicrotask(() => {
        const current = connector.state()
        if (current.status === "stopped" && current.reason === "revoked") {
          deps.log(`the control plane no longer accepts this machine (${decisionCode(error) ?? current.detail})`)
          decided?.(DECISION_EXIT_CODE)
        }
      })
    },
  })

  let unsubscribe = () => undefined as void
  const stopSignal = new Promise<number>((resolve) => {
    unsubscribe = deps.onStopSignal((signal) => {
      deps.log(`${signal}: draining`)
      resolve(0)
    })
  })

  let code: number
  try {
    const started = await withBootstrapRetry(
      deps,
      "acquire",
      async () => {
        const result = await connector.start()
        if (result.status === "stopped" && result.reason === "error") throw new StartFailure(result.detail)
        return result
      },
      (error) => error instanceof StartFailure,
    )
    if (started.status === "stopped") {
      deps.log(`the control plane refused this machine: ${started.detail}`)
      code = DECISION_EXIT_CODE
    } else {
      deps.log(`serving as ${enrollment.enrollment_id} (generation ${connector.generation()})`)
      code = await Promise.race([stopSignal, decision])
    }
  } catch (error) {
    deps.log(errorMessage(error))
    code = error instanceof HostConnectDecisionError ? error.exitCode : 1
  }

  unsubscribe()
  await connector.drain()
  connector.close()
  deps.stopServing()
  await listener.close()
  for (const [workspaceId, entry] of owned) {
    await entry.runtime?.close().catch((error: unknown) => {
      deps.log(`workspace ${workspaceId}: SDK runtime close failed: ${errorMessage(error)}`)
    })
  }
  owned.clear()
  const { run: _run, ...rest } = state
  await persist(rest)
  return code
}
