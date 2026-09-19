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

export type HostRuntimeListener = {
  /** The origin the serving loop's `localBaseUrl` points at. */
  url: string
  /** The runtime for this workspace, created on first call; a changed directory replaces it. */
  ensure: (workspace: HostWorkspaceRuntimeOptions) => Promise<WorkspaceRuntimeApp>
  /** Tear one runtime down, letting in-flight turns finish first. */
  dispose: (workspaceId: string) => Promise<void>
  workspaceIds: () => string[]
  /**
   * Re-resolve and apply the configuration on every live runtime, after the
   * rows it resolves against changed. One workspace's failure is logged and
   * the rest still move.
   */
  applyRuntimeConfig: () => Promise<void>
  /** Dispose every runtime and stop listening. */
  close: () => Promise<void>
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
  const retiring = new Map<string, Promise<void>>()
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

  const disposeEntry = (entry: Entry): Promise<void> => {
    const pending = retiring.get(entry.workspaceId)
    if (pending) return pending
    if (entries.get(entry.workspaceId) === entry) entries.delete(entry.workspaceId)
    const done = (async () => {
      // Freezing refuses new writes and resolves once every in-flight turn
      // and write has finished; the timeout bounds a turn that never does.
      // `dispose` then aborts whatever is left.
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          entry.runtime.host.checkpoint.freeze("drain"),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, drainTimeoutMs)
          }),
        ])
      } catch (error) {
        log.warn("host runtime drain failed; disposing anyway", { workspaceId: entry.workspaceId, error })
      } finally {
        if (timer) clearTimeout(timer)
      }
      await entry.runtime.dispose()
    })()
    retiring.set(entry.workspaceId, done)
    void done.then(
      () => {
        if (retiring.get(entry.workspaceId) === done) retiring.delete(entry.workspaceId)
      },
      () => { /* A failed retirement keeps the id fenced until the next ensure retries it. */ },
    )
    return done
  }

  const ensure: HostRuntimeListener["ensure"] = async (workspace) => {
    const pending = retiring.get(workspace.workspaceId)
    if (pending) await pending
    const hit = entries.get(workspace.workspaceId)
    if (hit) {
      if (hit.directory === workspace.directory) return hit.runtime
      await disposeEntry(hit)
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
    dispose: (workspaceId) => {
      const entry = entries.get(workspaceId)
      return entry ? disposeEntry(entry) : retiring.get(workspaceId) ?? Promise.resolve()
    },
    workspaceIds: () => [...entries.keys()].sort(),
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
      await Promise.all([...entries.values()].map(disposeEntry).concat([...retiring.values()]))
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}
