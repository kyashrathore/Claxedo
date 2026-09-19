import fs from "node:fs/promises"
import path from "node:path"
import { createHostConnector, type AssignmentDescription, type HostEndpoints } from "@claxedo/host-connector/connector"
import { DECISION_EXIT_CODE, HostConnectDecisionError } from "@claxedo/host-connector/bootstrap"
import { hostKeyPairFromJwk } from "@claxedo/host-connector/host-identity"
import { pathWithinRoots, resolveRoots, type HostScope, type HostState, type HostStateStore } from "@claxedo/host-connector/host-state"
import { createMachineSealingKeyPair, hostMachineSealAad, openMachineSeal, sealingPublicKeyJwk } from "@claxedo/host-connector/machine-seal"
import {
  createMachineSignedTransport,
  decisionCode,
  HostedHttpError,
  HostedRequestTimeoutError,
  MACHINE_REQUEST_TIMEOUT_MS,
  type FetchLike,
} from "@claxedo/host-connector/machine-transport"
import {
  createHostRuntimeListener,
  installHostProviderConfigAuthority,
  setHostProviderConfig,
  type HostRuntimeListener,
  type HostWorkspaceRuntimeOptions,
} from "@claxedo/host-serving/runtime"
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
import { DRAIN_TIMEOUT_MS, LEASE_TTL_MS, RUNTIME_CLOSE_TIMEOUT_MS } from "./paths"

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
  setTimeout: (fn: () => void, ms: number) => { cancel: () => void }
  /** Subscribe to the process's stop request; the returned function unsubscribes. */
  onStopSignal: (fn: (signal: string) => void) => () => void
  /** Wall clock, for the persisted run record. */
  now: () => number
  /** Monotonic milliseconds, for budgets: a wall clock stepped by NTP or a sleep would lengthen or cut them. */
  monotonicNow: () => number
  sleep: (ms: number) => Promise<void>
  log: (line: string) => void
  pid: number
}

export function defaultHostDeps(): HostDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    createListener: () => createHostRuntimeListener({ hostname: "127.0.0.1", port: 0, drainTimeoutMs: RUNTIME_CLOSE_TIMEOUT_MS }),
    openCodeRuntime: (directory) => createWorkspaceOpenCodeRuntime(directory),
    setServing: setUserHostedServing,
    servingState: userHostedServingState,
    stopServing: stopUserHostedServing,
    resolvePath: (target) => fs.realpath(target),
    setInterval: (fn, ms) => {
      const handle = setInterval(fn, ms)
      return { cancel: () => clearInterval(handle) }
    },
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms)
      return { cancel: () => clearTimeout(handle) }
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
    monotonicNow: () => performance.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
    pid: process.pid,
  }
}

export const BEAT_INTERVAL_MS = Math.min(LEASE_TTL_MS / 3, 20_000)

/**
 * Transport failures are retried until this much time has passed since the
 * first attempt, then the process gives up with exit 1. Each attempt is
 * handed what is left of the budget as its request deadline, and no attempt
 * starts with less than `MIN_ATTEMPT_BUDGET_MS`, so the budget is the bound.
 */
export const BOOTSTRAP_RETRY_BUDGET_MS = 5 * 60_000
export const MIN_ATTEMPT_BUDGET_MS = 1_000
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
  deps: Pick<HostDeps, "sleep" | "monotonicNow" | "log">,
  label: string,
  attempt: (budget: { timeoutMs: number }) => Promise<T>,
  transient: (error: unknown) => boolean = transientBootstrapFailure,
): Promise<T> {
  const started = deps.monotonicNow()
  const deadline = started + BOOTSTRAP_RETRY_BUDGET_MS
  const giveUp = (error: unknown) =>
    new Error(`${label} failed for ${Math.round((deps.monotonicNow() - started) / 1000)}s: ${errorMessage(error)}`, { cause: error })
  let delay = 1_000
  let lastError: unknown
  for (;;) {
    const remaining = deadline - deps.monotonicNow()
    // Reached only when a sleep overshot: the pause below always leaves at least the minimum.
    if (remaining < MIN_ATTEMPT_BUDGET_MS) throw giveUp(lastError)
    try {
      return await attempt({ timeoutMs: remaining })
    } catch (error) {
      if (!transient(error)) throw error
      lastError = error
      const left = deadline - deps.monotonicNow()
      // A retry is a pause and then an attempt with the minimum; anything less is over.
      if (left <= MIN_ATTEMPT_BUDGET_MS) throw giveUp(error)
      const wait = Math.min(delay, left - MIN_ATTEMPT_BUDGET_MS)
      deps.log(`${label} failed (${errorMessage(error)}); retrying in ${wait / 1000}s`)
      await deps.sleep(wait)
      delay = Math.min(delay * 2, RETRY_CAP_MS)
    }
  }
}

/** `connector.start()` reporting a transport failure on acquire; the connector can be started again. */
class StartFailure extends Error {}

async function drainWithin(drain: Promise<void>, deps: Pick<HostDeps, "setTimeout" | "log">) {
  let timer: { cancel: () => void } | undefined
  const expired = new Promise<"expired">((resolve) => {
    timer = deps.setTimeout(() => resolve("expired"), DRAIN_TIMEOUT_MS)
  })
  try {
    const outcome = await Promise.race([drain.then(() => "drained" as const), expired])
    if (outcome === "expired") deps.log(`drain did not finish within ${DRAIN_TIMEOUT_MS / 1000}s; closing anyway`)
  } finally {
    timer?.cancel()
  }
}

/** The heartbeat ack's `hostTunnel` verbatim from the control plane, or nothing serveable. */
export function servingCredential(tunnel: unknown, fallbackRelayUrl: string | undefined): UserHostedServingCredential | null {
  const row = asRecordOrEmpty(tunnel)
  const hostId = trimToUndefined(row.hostId)
  const enrollmentId = trimToUndefined(row.enrollmentId)
  const token = trimToUndefined(row.hostTunnelToken)
  const expiresAt = asFiniteNumber(row.tokenExpiresAt)
  const relayUrl = trimToUndefined(row.relayUrl) ?? fallbackRelayUrl
  const workspaceIds = Array.isArray(row.workspaceIds)
    ? row.workspaceIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : []
  if (!hostId || !enrollmentId || !token || !expiresAt || !relayUrl || workspaceIds.length === 0) return null
  return { hostId, enrollmentId, relayUrl, token, workspaceIds, expiresAt }
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
  // state written is the last state computed. The chain outlives a failed
  // write; only the caller that asked for that write hears of it.
  let saving: Promise<void> = Promise.resolve()
  const persistOrThrow = (next: HostState) => {
    state = next
    const write = saving.then(() => input.store.save(next))
    saving = write.catch(() => undefined)
    return write
  }
  const persist = (next: HostState) =>
    persistOrThrow(next).catch((error: unknown) => {
      deps.log(`could not write host state: ${errorMessage(error)}`)
    })

  installHostProviderConfigAuthority()
  // The public half is derived from the stored private JWK on every boot, so
  // the key the control plane seals for can only be the key on disk; it is
  // on disk before the first beat declares it.
  const sealingPrivateKeyJwk = state.sealing_private_key_jwk ?? (await createMachineSealingKeyPair()).privateKeyJwk
  if (sealingPrivateKeyJwk !== state.sealing_private_key_jwk) {
    await persistOrThrow({ ...state, sealing_private_key_jwk: sealingPrivateKeyJwk })
  }
  const sealingPublicKey = JSON.stringify(sealingPublicKeyJwk(sealingPrivateKeyJwk))

  const installProviderConfig = async (config: { revision: number; sealed: string | null }) => {
    const plaintext = config.sealed === null
      ? null
      : await openMachineSeal(sealingPrivateKeyJwk, config.sealed, hostMachineSealAad({ enrollmentId: enrollment.enrollment_id, revision: config.revision }))
    const { providerIds } = setHostProviderConfig(plaintext)
    deps.log(
      config.sealed === null
        ? `provider configuration revision ${config.revision}: withdrawn; harnesses run on this machine's own logins`
        : `provider configuration revision ${config.revision}: ${providerIds.join(", ") || "no providers"}`,
    )
  }
  // A stored revision is declared only once it is open again: a blob on disk
  // this key cannot open would otherwise be acked forever, and the owner would
  // read "applied" for a configuration no harness here has.
  let declaredProviderConfigRevision: number | undefined
  if (state.provider_config) {
    try {
      await installProviderConfig(state.provider_config)
      declaredProviderConfigRevision = state.provider_config.revision
    } catch (error) {
      deps.log(`stored provider configuration revision ${state.provider_config.revision} could not be applied: ${errorMessage(error)}`)
    }
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

  // Each root's canonical form is recorded the first time it resolves and
  // the record is compared on every later resolution; a drift is reported
  // once per root and destination, not on every ack.
  const reportedDrift = new Set<string>()
  const canonicalRoots = async () => {
    const resolved = await resolveRoots(state, deps.resolvePath)
    for (const drift of resolved.drifted) {
      const key = `${drift.root} -> ${drift.resolved}`
      if (reportedDrift.has(key)) continue
      reportedDrift.add(key)
      deps.log(
        `root ${drift.root} now resolves to ${drift.resolved}, not ${drift.recorded} as recorded when it was first resolved; nothing under it is served until \`claxedo connect --reset-roots\` or a new scope from the owner re-records it`,
      )
    }
    if (JSON.stringify(resolved.canonical) !== JSON.stringify(state.roots_canonical ?? {})) {
      void persist({ ...state, roots_canonical: resolved.canonical })
    }
    return resolved.roots
  }

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
    transport,
    enrollmentId: enrollment.enrollment_id,
    heartbeatIntervalMs: BEAT_INTERVAL_MS,
    sessionAuthority: "managed-private",
    sealingPublicKey,
    ...(declaredProviderConfigRevision === undefined ? {} : { providerConfigRevision: declaredProviderConfigRevision }),
    roots: canonicalRoots,
    resolvePath: deps.resolvePath,
    setInterval: deps.setInterval,
    onScope: (scope: HostScope) => {
      // A new scope revision is the owner re-declaring the roots, so the
      // pins are re-recorded from what they resolve to now. The same
      // revision delivered again — every boot's first beat — keeps them.
      if (scope.revision === state.scope?.revision) return persist({ ...state, scope })
      const { roots_canonical: _stale, ...rest } = state
      return persist({ ...rest, scope })
    },
    onEndpoints: (endpoints: HostEndpoints) =>
      persist({
        ...state,
        ...(endpoints.relay ? { relay: endpoints.relay } : {}),
        ...(endpoints.authority ? { authority: endpoints.authority } : {}),
      }),
    // Stored, then opened, then applied. The connector acks a revision only
    // when this resolves, so a write that fails throws here and the control
    // plane delivers the same revision on the next beat.
    onProviderConfig: async (config) => {
      await persistOrThrow({ ...state, provider_config: config })
      await installProviderConfig(config)
      await listener.applyRuntimeConfig()
    },
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
      async ({ timeoutMs }) => {
        const result = await connector.start({ acquireTimeoutMs: Math.min(MACHINE_REQUEST_TIMEOUT_MS, timeoutMs) })
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
  await drainWithin(connector.drain(), deps)
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
