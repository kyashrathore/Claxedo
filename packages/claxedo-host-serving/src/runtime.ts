/**
 * The workspace runtime a `claxedo connect` host answers the relay with, and
 * the one loopback listener that fronts every runtime the host serves.
 *
 * A host process is outside the control plane, so its runtimes are composed
 * the way `workspace-runtime/src/cli.ts` composes a sandbox: the relay
 * exposure verifies each Relay Host Token against the relay's published key
 * set, and the remote session policy asks the control plane's session
 * authority over HTTP for every private-session decision. Nothing here is
 * new mechanism — both halves are the kit's own, reached through the same
 * env-shaped entry the sandbox CLI reads, so a host trusts the relay by
 * exactly the mechanism a sandbox does.
 *
 * The serving loop (`serving.ts`) dials one relay connection per workspace
 * and forwards each admitted request to `<localBaseUrl>/workspaces/<id>/...`;
 * the listener below is that origin. Runtimes come and go while it listens —
 * an assignment arrives on a heartbeat, a withdrawal on a later one — so the
 * map is consulted per request rather than baked into the router.
 */

import { createServer, type IncomingMessage, type Server } from "node:http"
import type { Duplex } from "node:stream"
import { Hono } from "hono"
import { getRequestListener } from "@hono/node-server"
import {
  createWorkspaceRuntimeApp,
  Pty,
  relayWorkspaceRuntimeExposure,
  type WorkspaceRuntimeApp,
  type WorkspaceRuntimeServerOptions,
} from "@claxedo/workspace-runtime"
import { createAuthorityGrants, remoteWorkspaceSessionAccessPolicy, type AuthorityGrants } from "@claxedo/session-core"
import { relayHostAuthFromEnv } from "@claxedo/workspace-runtime/relay"
import { runtimeAccessAdmission } from "./direct-admission"
import { createDocumentHydration, documentHydrationContribution } from "@claxedo/documents/runtime"
import { isSessionConfigRefusal } from "@claxedo/workspace-runtime/config"
import { configureAgentConfig } from "@claxedo/server-core/agent-config/index"
import {
  hostProviderConfigProjectAuth,
  layeredHostProviderConfig,
  parseHostProviderConfig,
  type HostProviderConfig,
  type HostProviderConfigSource,
} from "@claxedo/server-core/credentials/host-provider-config"
import { createClaxedoAppliedRuntimeConfig } from "@claxedo/server-core/hosts/workspace-runtime/runtime-config"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { adoptHostEnrolledOwner, hostEnrolledOwner } from "./serving"

const log = Log.create({ service: "host-runtime" })

/**
 * A connected host is the enrolling person's own machine: loopback callers are
 * its owner, and so is the enrolled owner arriving through the relay, because
 * the credential snapshot names them its machine owner. Other members are
 * brokered.
 */
export const CONNECTED_HOST_PLACEMENT: WorkspaceRuntimeServerOptions["placement"] = { placement: "desktop", machineOwnerUserId: "", canUseOwnLogin: true }

/** The latest revision of each source this host holds: the owner's push, and the control plane's build from their accounts. */
const held: Record<HostProviderConfigSource, HostProviderConfig["credentials"] | undefined> = { owner: undefined, "control-plane": undefined }

const spent = () => layeredHostProviderConfig(held.owner, held["control-plane"])

/**
 * Make the owner's configurations this process's only credential authority:
 * the rows the control plane built from their accounts, with the rows they
 * pushed by hand over them. A connect host has no credential registry of its
 * own, so there is no base answer to write the rows over and no account
 * choice to honour; a provider neither names resolves to nothing and the
 * harness runs on whatever login the box holds. It starts holding nothing:
 * the host installs what it stored before its first beat.
 */
export function installHostProviderConfigAuthority() {
  held.owner = undefined
  held["control-plane"] = undefined
  configureAgentConfig({ projectAuth: hostProviderConfigProjectAuth(undefined, spent, hostEnrolledOwner, () => ({})) })
}

/**
 * Which configuration a revision the host opened replaces; a withdrawal
 * (`null`) is always the owner's. Throws on a payload this host cannot read.
 */
export function hostProviderConfigSource(plaintext: string | null): HostProviderConfigSource {
  return plaintext === null ? "owner" : parseHostProviderConfig(plaintext).source
}

/**
 * Replace the configuration of the plaintext's source with it, or withdraw
 * the owner's push on `null`; answers the providers the host now spends.
 * Parsed here rather than by the caller because the CLI does not depend on
 * `@claxedo/server-core`, and the rows themselves never leave this module.
 * Throws on a payload this host cannot read, leaving every row in place.
 */
export function setHostProviderConfig(plaintext: string | null): { source: HostProviderConfigSource; providerIds: string[] } {
  const config = plaintext === null ? undefined : parseHostProviderConfig(plaintext)
  const source = config?.source ?? "owner"
  held[source] = config?.credentials
  const providers = spent()
  return { source, providerIds: providers ? [...new Set(Object.values(providers.accounts).flatMap((rows) => Object.keys(rows)))].sort() : [] }
}

/** Adopt the enrolled owner a heartbeat ack names, re-applying every live runtime under them. */
export async function adoptConnectedHostOwner(owner: string, listener: Pick<HostRuntimeListener, "applyRuntimeConfig">): Promise<void> {
  await adoptHostEnrolledOwner(owner, {
    forget: (next) => {
      for (const source of ["owner", "control-plane"] as const) {
        if (held[source] && held[source].machineOwnerUserId !== next) held[source] = undefined
      }
    },
    reapply: () => listener.applyRuntimeConfig(),
  })
}

/** The snapshot this process resolves for one workspace, applied in process: the host composes its own runtimes and needs no config route. */
async function applyRuntimeConfig(runtime: WorkspaceRuntimeApp, target: { workspaceId: string; directory: string }) {
  await runtime.host.apply(await createClaxedoAppliedRuntimeConfig({ workspaceDir: target.directory, workspaceId: target.workspaceId }))
}

export type HostWorkspaceRuntimeOptions = {
  sessionIdWorkspace: WorkspaceRuntimeServerOptions["sessionIdWorkspace"]
  workspaceId: string
  directory: string
  /** The enrollment's host id — the `host_id` every Relay Host Token for this machine carries. */
  hostId: string
  relay: {
    /** The relay's published key set; Relay Host Tokens are verified against it by `kid`. */
    jwksUrl: string
  }
  /** The control plane's session authority, consulted for every private-session decision it has not let this host reuse. */
  sessionAuthorityUrl: string
  /** One store for every runtime this host serves, so one ring of the doorbell forgets every reused answer. */
  authorityGrants?: AuthorityGrants
  /**
   * The control plane's published key set, present while the direct listener
   * is on: the owner's Runtime Access Token is then admitted as the relay's
   * host token is.
   */
  runtimeAccessJwksUrl?: string
  /** Per-workspace state root from the persisted host state's `storage_root`. */
  storeRoot: string
  harness?: WorkspaceRuntimeServerOptions["harness"]
  routeContributions?: WorkspaceRuntimeServerOptions["routeContributions"]
}

export async function createHostWorkspaceRuntime(options: HostWorkspaceRuntimeOptions): Promise<WorkspaceRuntimeApp> {
  // The sandbox CLI's own key loader, fed the same variables it reads from a
  // sandbox's environment. It returns nothing only when neither key source is
  // set, and the JWKS URL is required above.
  const relayHostAuth = await relayHostAuthFromEnv({
    WORKSPACE_RUNTIME_RELAY_JWKS_URL: options.relay.jwksUrl,
    WORKSPACE_RUNTIME_WORKSPACE_ID: options.workspaceId,
    WORKSPACE_RUNTIME_HOST_ID: options.hostId,
  })
  if (!relayHostAuth) throw new Error("Host workspace runtime requires a relay JWKS URL")
  const target = { workspaceId: options.workspaceId, directory: options.directory }
  const sessionAccessPolicy = remoteWorkspaceSessionAccessPolicy({
    url: options.sessionAuthorityUrl,
    ...(options.authorityGrants ? { grants: options.authorityGrants } : {}),
  })
  const runtimeAccess = options.runtimeAccessJwksUrl
    ? runtimeAccessAdmission({ jwksUrl: options.runtimeAccessJwksUrl, policy: sessionAccessPolicy })
    : undefined
  const runtime = createWorkspaceRuntimeApp({
    target,
    sessionIdWorkspace: options.sessionIdWorkspace,
    exposure: relayWorkspaceRuntimeExposure({ ...relayHostAuth, ...(runtimeAccess ? { runtimeAccess } : {}) }),
    sessionAccessPolicy,
    storeRoot: options.storeRoot,
    placement: CONNECTED_HOST_PLACEMENT,
    ...(options.harness ? { harness: options.harness } : {}),
    routeContributions: [
      documentHydrationContribution(createDocumentHydration(
        process.env.CLAXEDO_CONTROL_PLANE_URL ? { controlPlaneOrigin: process.env.CLAXEDO_CONTROL_PLANE_URL } : {},
      )),
      ...(options.routeContributions ?? []),
    ],
  })
  try {
    await applyRuntimeConfig(runtime, target)
  } catch (error) {
    await runtime.dispose().catch(() => undefined)
    throw error
  }
  return runtime
}

export type HostRuntimeListenerOptions = {
  hostname: "127.0.0.1"
  /** 0 lets the OS pick; `url` reports the bound port either way. */
  port: number
  /** How long `dispose` waits for in-flight turns and writes before tearing the runtime down. */
  drainTimeoutMs?: number
}

type Entry = {
  workspaceId: string
  directory: string
  runtime: WorkspaceRuntimeApp
  /**
   * The runtime's WebSocket helper subscribes to `upgrade` on the server it is
   * handed and reads `request.url`. The listener owns the one bound server,
   * so each runtime is given a server that never listens and the listener
   * re-emits only the upgrades addressed to that workspace, prefix stripped.
   */
  upgrades: Server
}

/**
 * What this host still owns for a workspace. A retirement that failed leaves
 * an owner behind rather than an absence: its store root and whatever its
 * runtime still holds are not free for a replacement writer, and the only way
 * to learn that is to see the owner.
 */
export type HostRuntimeOwner = {
  workspaceId: string
  state: "serving" | "retiring" | "retire_failed"
  attempt: number
  error?: string
}

export type HostRuntimeRetirementResult = {
  workspaceId: string
  state: "retired" | "retire_failed"
  attempt: number
  /** The drain deadline expired before the runtime reported itself quiet. */
  timedOut: boolean
  /** The drain refused; teardown still ran, and what it left is unverified. */
  drainError?: string
  error?: string
}

export class HostRuntimeRetirementUnresolvedError extends Error {
  readonly code = "host_runtime_retirement_unresolved"

  constructor(readonly workspaceId: string, readonly attempt: number, readonly reason: string) {
    super(
      `Workspace ${workspaceId} cannot be served again: retirement attempt ${attempt} failed (${reason}). `
        + "Retire it again with retry before a replacement runtime is created.",
    )
    this.name = "HostRuntimeRetirementUnresolvedError"
  }
}

export type HostRuntimeListener = {
  /** The origin the serving loop's `localBaseUrl` points at. */
  url: string
  /** A `/workspaces/:id/*` request answered in process, as the listener answers it. */
  fetch: (request: Request) => Promise<Response>
  /** A `/workspaces/:id/*` upgrade carried in process, as the listener carries it. */
  upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  /** The runtime for this workspace, created on first call; a changed directory replaces it. */
  ensure: (workspace: Omit<HostWorkspaceRuntimeOptions, "sessionIdWorkspace">) => Promise<WorkspaceRuntimeApp>
  /**
   * Tear one runtime down, letting in-flight turns finish first. Joins a
   * retirement already under way; `retry` starts a fresh attempt for one that
   * failed, rerunning only the steps that did not complete.
   */
  dispose: (workspaceId: string, options?: { retry?: boolean }) => Promise<HostRuntimeRetirementResult>
  /** Every workspace this host still owns, serving or not. */
  owners: () => HostRuntimeOwner[]
  /**
   * Re-resolve and apply the configuration on every live runtime, after the
   * rows it resolves against changed. One workspace's failure does not stop
   * the rest; the failures are then reported together.
   */
  applyRuntimeConfig: () => Promise<void>
  /** Drop every authority answer the runtimes reuse, when the control plane rings that someone's access may have narrowed. */
  forgetAuthorityGrants: () => void
  /** Retire every runtime and stop listening; a failed owner is reported, not lost. */
  close: () => Promise<{ ok: boolean; results: HostRuntimeRetirementResult[] }>
}

const WORKSPACE_PREFIX = /^\/workspaces\/([^/]+)(\/.*)?$/

function servedWorkspaceRoute(url: URL): { workspaceId: string; path: string } | undefined {
  const match = WORKSPACE_PREFIX.exec(url.pathname)
  if (!match) return undefined
  let workspaceId: string
  try {
    workspaceId = decodeURIComponent(match[1])
  } catch {
    return undefined
  }
  return { workspaceId, path: `${match[2] ?? "/"}${url.search}` }
}

function workspaceNotServed(workspaceId: string | undefined) {
  return Response.json({
    error: {
      code: "workspace_not_served",
      message: workspaceId ? `Workspace ${workspaceId} is not served by this host` : "Not a workspace route",
    },
  }, { status: 404 })
}

export async function createHostRuntimeListener(options: HostRuntimeListenerOptions): Promise<HostRuntimeListener> {
  const entries = new Map<string, Entry>()
  const drainTimeoutMs = options.drainTimeoutMs ?? 10_000
  const authorityGrants = createAuthorityGrants()

  const app = new Hono()
  app.all("*", (c) => {
    const url = new URL(c.req.url)
    const route = servedWorkspaceRoute(url)
    const entry = route && entries.get(route.workspaceId)
    if (!route || !entry) return workspaceNotServed(route?.workspaceId)
    // Rebuilt from the original so method, headers and body carry over; only
    // the URL changes, because the runtime app is rooted at `/`.
    return entry.runtime.app.fetch(new Request(new URL(route.path, url.origin), c.req.raw))
  })

  const server = createServer(getRequestListener(app.fetch))
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    const route = servedWorkspaceRoute(url)
    const entry = route && entries.get(route.workspaceId)
    if (!route || !entry) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
      return
    }
    request.url = route.path
    entry.upgrades.emit("upgrade", request, socket, head)
  }
  server.on("upgrade", upgrade)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port, options.hostname, () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Host runtime listener did not bind a TCP port")
  const url = `http://${options.hostname}:${address.port}`

  /**
   * A retirement in progress or stuck. It outlives its `Entry` on purpose: the
   * runtime is no longer routed to, but whatever it did not release is still
   * this host's, and a replacement writer must not be admitted over it.
   */
  type Retirement = {
    workspaceId: string
    entry: Entry
    attempt: number
    /** Freeze/drain finished (however it went); a retry does not redo it. */
    drained: boolean
    timedOut: boolean
    drainError?: string
    state: "retiring" | "retire_failed"
    error?: string
    done: Promise<HostRuntimeRetirementResult>
  }

  const retirements = new Map<string, Retirement>()

  const drain = async (record: Retirement) => {
    const deadlineAt = Date.now() + drainTimeoutMs
    try {
      const frozen = await record.entry.runtime.host.checkpoint.freeze("drain", { deadlineAt })
      record.timedOut = frozen.state !== "frozen"
      if (frozen.state === "blocked") {
        // Teardown still runs — that is the point of retiring — but the
        // writers the freeze named were never fenced, so what this runtime
        // was holding is unverified.
        record.drainError = `checkpoint blocked: ${frozen.blockers.map((blocker) => blocker.reason).join(", ")}`
        log.warn("host runtime drain blocked; disposing anyway", { workspaceId: record.workspaceId, blockers: frozen.blockers })
      }
    } catch (error) {
      record.drainError = String(error)
      log.warn("host runtime drain failed; disposing anyway", { workspaceId: record.workspaceId, error })
    }
    record.drained = true
  }

  const runRetirement = async (record: Retirement): Promise<HostRuntimeRetirementResult> => {
    try {
      if (!record.drained) await drain(record)
      await record.entry.runtime.dispose()
      record.state = "retiring"
      retirements.delete(record.workspaceId)
      return {
        workspaceId: record.workspaceId,
        state: "retired",
        attempt: record.attempt,
        timedOut: record.timedOut,
        ...(record.drainError ? { drainError: record.drainError } : {}),
      }
    } catch (error) {
      record.state = "retire_failed"
      record.error = String(error)
      log.warn("host runtime retirement failed", { workspaceId: record.workspaceId, attempt: record.attempt, error })
      return {
        workspaceId: record.workspaceId,
        state: "retire_failed",
        attempt: record.attempt,
        timedOut: record.timedOut,
        ...(record.drainError ? { drainError: record.drainError } : {}),
        error: record.error,
      }
    }
  }

  const retireEntry = (entry: Entry): Promise<HostRuntimeRetirementResult> => {
    const pending = retirements.get(entry.workspaceId)
    if (pending) return pending.done
    if (entries.get(entry.workspaceId) === entry) entries.delete(entry.workspaceId)
    const record: Retirement = {
      workspaceId: entry.workspaceId,
      entry,
      attempt: 1,
      drained: false,
      timedOut: false,
      state: "retiring",
      done: Promise.resolve({ workspaceId: entry.workspaceId, state: "retired", attempt: 1, timedOut: false }),
    }
    record.done = runRetirement(record)
    retirements.set(entry.workspaceId, record)
    return record.done
  }

  const retire: HostRuntimeListener["dispose"] = (workspaceId, options = {}) => {
    const entry = entries.get(workspaceId)
    if (entry) return retireEntry(entry)
    const record = retirements.get(workspaceId)
    if (!record) return Promise.resolve({ workspaceId, state: "retired", attempt: 0, timedOut: false })
    if (record.state === "retiring") return record.done
    if (!options.retry) {
      return Promise.resolve({
        workspaceId,
        state: "retire_failed",
        attempt: record.attempt,
        timedOut: record.timedOut,
        ...(record.drainError ? { drainError: record.drainError } : {}),
        ...(record.error ? { error: record.error } : {}),
      })
    }
    record.attempt += 1
    record.state = "retiring"
    delete record.error
    record.done = runRetirement(record)
    return record.done
  }

  const ensure: HostRuntimeListener["ensure"] = async (workspace) => {
    const unresolved = retirements.get(workspace.workspaceId)
    if (unresolved) {
      if (unresolved.state === "retiring") await unresolved.done
      const settled = retirements.get(workspace.workspaceId)
      // A retry is an explicit operation, never something creation performs on
      // its own: the old owner's cleanup is unverified until one succeeds.
      if (settled) {
        throw new HostRuntimeRetirementUnresolvedError(
          workspace.workspaceId,
          settled.attempt,
          settled.error ?? "retirement did not complete",
        )
      }
    }
    const hit = entries.get(workspace.workspaceId)
    if (hit) {
      if (hit.directory === workspace.directory) return hit.runtime
      await retireEntry(hit)
      return ensure(workspace)
    }
    const runtime = await createHostWorkspaceRuntime({
      ...workspace,
      authorityGrants,
      sessionIdWorkspace: (sessionId) => {
        for (const entry of entries.values()) {
          const binding = entry.runtime.host.store().getExecutionBinding(sessionId)
          if (binding) return binding.workspaceId
        }
        return undefined
      },
    })
    // Creation yielded; one workspace id owns exactly one runtime.
    const raced = entries.get(workspace.workspaceId)
    if (raced) {
      await runtime.dispose()
      return ensure(workspace)
    }
    const upgrades = createServer()
    runtime.injectWebSocket(upgrades)
    entries.set(workspace.workspaceId, { workspaceId: workspace.workspaceId, directory: workspace.directory, runtime, upgrades })
    log.info("host runtime started", { workspaceId: workspace.workspaceId, directory: workspace.directory })
    Pty.warm()
    return runtime
  }

  return {
    url,
    fetch: async (request) => await app.fetch(request),
    upgrade,
    ensure,
    dispose: retire,
    forgetAuthorityGrants: () => authorityGrants.forget(),
    owners: () => [
      ...[...entries.keys()].map((workspaceId) => ({ workspaceId, state: "serving" as const, attempt: 0 })),
      ...[...retirements.values()].map((record) => ({
        workspaceId: record.workspaceId,
        state: record.state,
        attempt: record.attempt,
        ...(record.error ? { error: record.error } : {}),
      })),
    ].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
    applyRuntimeConfig: async () => {
      const results = await Promise.allSettled([...entries.values()].map((entry) => applyRuntimeConfig(entry.runtime, entry)))
      const failed = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
      for (const refusal of failed.filter(isSessionConfigRefusal)) {
        log.warn("a harness refused a session's configuration", { error: String(refusal) })
      }
      const broken = failed.filter((error) => !isSessionConfigRefusal(error))
      if (broken.length > 0) throw new AggregateError(broken, `${broken.length} host runtime(s) failed to apply their configuration`)
    },
    close: async () => {
      // Settled, not raced: one owner's failed retirement must not discard the
      // outcome of every other owner's. Owners already retiring are collected
      // before the serving ones start, so neither is counted twice.
      const pending = [
        ...[...retirements.values()].map((record) => ({ workspaceId: record.workspaceId, done: record.done })),
        ...[...entries.values()].map((entry) => ({ workspaceId: entry.workspaceId, done: retireEntry(entry) })),
      ]
      const settled = await Promise.allSettled(pending.map((owner) => owner.done))
      const results = settled.map((outcome, index): HostRuntimeRetirementResult =>
        outcome.status === "fulfilled"
          ? outcome.value
          : {
            workspaceId: pending[index].workspaceId,
            state: "retire_failed",
            attempt: 0,
            timedOut: false,
            error: String(outcome.reason),
          })
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      return { ok: results.every((result) => result.state === "retired"), results }
    },
  }
}
