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

import { createServer, type Server } from "node:http"
import { Hono } from "hono"
import { getRequestListener } from "@hono/node-server"
import {
  createWorkspaceRuntimeApp,
  relayWorkspaceRuntimeExposure,
  remoteWorkspaceSessionAccessPolicy,
  type WorkspaceRuntimeApp,
  type WorkspaceRuntimeServerOptions,
} from "@claxedo/workspace-runtime"
import { relayHostAuthFromEnv } from "@claxedo/workspace-runtime/relay"
import { configureAgentConfig } from "@claxedo/server-core/agent-config/index"
import {
  hostProviderConfigProjectAuth,
  parseHostProviderConfig,
  type HostProviderConfig,
} from "@claxedo/server-core/credentials/host-provider-config"
import { createClaxedoAppliedRuntimeConfig } from "@claxedo/server-core/hosts/workspace-runtime/runtime-config"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"

const log = Log.create({ service: "host-runtime" })

let pushedProviders: HostProviderConfig["providers"] = {}

/**
 * Make the owner's pushed rows this process's only credential authority. A
 * connect host has no credential registry of its own, so there is no base
 * answer to write the rows over; a provider the owner has not pushed resolves
 * to nothing and the harness runs on whatever login the box holds.
 */
export function installHostProviderConfigAuthority() {
  configureAgentConfig({ projectAuth: hostProviderConfigProjectAuth(undefined, () => pushedProviders) })
}

/**
 * Replace the pushed rows with the plaintext the host opened, or with nothing
 * when the owner withdrew them. Parsed here rather than by the caller because
 * the CLI does not depend on `@claxedo/server-core`, and the rows themselves
 * never leave this module. Throws on a payload this host cannot read, leaving
 * the previous rows in place.
 */
export function setHostProviderConfig(plaintext: string | null): { providerIds: string[] } {
  const providers = plaintext === null ? {} : parseHostProviderConfig(plaintext).providers
  pushedProviders = providers
  return { providerIds: Object.keys(providers).sort() }
}

/** The snapshot this process resolves for one workspace, applied in process: the host composes its own runtimes and needs no config route. */
async function applyRuntimeConfig(runtime: WorkspaceRuntimeApp, target: { workspaceId: string; directory: string }) {
  await runtime.host.apply(await createClaxedoAppliedRuntimeConfig({ workspaceDir: target.directory, workspaceId: target.workspaceId }))
}

export type HostWorkspaceRuntimeOptions = {
  workspaceId: string
  directory: string
  /** The enrollment's host id — the `host_id` every Relay Host Token for this machine carries. */
  hostId: string
  relay: {
    /** The relay's published key set; Relay Host Tokens are verified against it by `kid`. */
    jwksUrl: string
  }
  /** The control plane's session authority, consulted for every private-session decision. */
  sessionAuthorityUrl: string
  /** Per-workspace state root from the persisted host state's `storage_root`. */
  storeRoot: string
  opencodeRuntime?: WorkspaceRuntimeServerOptions["opencodeRuntime"]
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
  const runtime = createWorkspaceRuntimeApp({
    target,
    exposure: relayWorkspaceRuntimeExposure(relayHostAuth),
    sessionAccessPolicy: remoteWorkspaceSessionAccessPolicy({ url: options.sessionAuthorityUrl }),
    storeRoot: options.storeRoot,
    ...(options.opencodeRuntime ? { opencodeRuntime: options.opencodeRuntime } : {}),
    ...(options.harness ? { harness: options.harness } : {}),
    ...(options.routeContributions ? { routeContributions: options.routeContributions } : {}),
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
  /** The runtime for this workspace, created on first call; a changed directory replaces it. */
  ensure: (workspace: HostWorkspaceRuntimeOptions) => Promise<WorkspaceRuntimeApp>
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
   * rows it resolves against changed. One workspace's failure is logged and
   * the rest still move.
   */
  applyRuntimeConfig: () => Promise<void>
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
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    const route = servedWorkspaceRoute(url)
    const entry = route && entries.get(route.workspaceId)
    if (!route || !entry) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
      return
    }
    request.url = route.path
    entry.upgrades.emit("upgrade", request, socket, head)
  })
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
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const raced = await Promise.race([
        record.entry.runtime.host.checkpoint.freeze("drain").then(() => "frozen" as const),
        new Promise<"timed_out">((resolve) => {
          timer = setTimeout(() => resolve("timed_out"), drainTimeoutMs)
        }),
      ])
      record.timedOut = raced === "timed_out"
    } catch (error) {
      // Teardown still runs — that is the point of retiring — but a refused
      // drain means nothing verified what the runtime was still holding.
      record.drainError = String(error)
      log.warn("host runtime drain failed; disposing anyway", { workspaceId: record.workspaceId, error })
    } finally {
      if (timer) clearTimeout(timer)
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
    const runtime = await createHostWorkspaceRuntime(workspace)
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
    return runtime
  }

  return {
    url,
    ensure,
    dispose: retire,
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
      await Promise.all([...entries.values()].map(async (entry) => {
        try {
          await applyRuntimeConfig(entry.runtime, entry)
        } catch (error) {
          log.warn("host runtime config apply failed", { workspaceId: entry.workspaceId, error })
        }
      }))
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
            workspaceId: pending[index]!.workspaceId,
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
