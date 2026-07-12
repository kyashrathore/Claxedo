import { Hono, type MiddlewareHandler } from "hono"
import { cors } from "hono/cors"
import { serve } from "@hono/node-server"
import { createNodeWebSocket } from "@hono/node-ws"
import type { UpgradeWebSocket } from "hono/ws"
import { Pty } from "./pty/index"
import * as ProcessManager from "./managed-processes/manager"
import { withWorkspaceTarget, workspaceDir, workspaceId, type WorkspaceTarget } from "./target"
import type { OpenCodeRequestFn, PiModelBackendResolver } from "@claxedo/agent-sdk-runtime/adapters"
import { createWorkspaceHost } from "./workspace"
import { setupAgentHooks } from "./agent-hooks"
import { createRelayHostAuthMiddleware, type RelayHostAuthOptions } from "./workspace-host-service-auth"
import {
  startWorkspaceRelayHostTunnel,
  type WorkspaceRelayHostTunnel,
  type WorkspaceRelayHostTunnelOptions,
} from "./workspace-relay-host-tunnel"
import { ConfigRoutes, type RuntimeRunner } from "./routes/config"
import { SessionEnvRoutes } from "./routes/session-env"
import { WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER, type WorkspaceRuntimeManagementAuth, type WorkspaceRuntimeManagementTarget } from "./management-auth"
import { WorkspaceRuntimeRoutes } from "./routes/manifest"
import {
  assertWorkspaceRuntimeExposure,
  createWorkspaceRuntimeExposureMiddleware,
  exposureBoundaryName,
  loopbackWorkspaceRuntimeExposure,
  privateNetworkDevUnsafeWorkspaceRuntimeExposure,
  relayWorkspaceRuntimeExposure,
  type WorkspaceRuntimeExposure,
} from "./exposure"
import { runtimeEnvText } from "./env"

type Host = ReturnType<typeof createWorkspaceHost>
export type WorkspaceRuntimeApp = {
  app: Hono
  host: Host
  injectWebSocket: (server: Parameters<ReturnType<typeof createNodeWebSocket>["injectWebSocket"]>[0]) => void
  upgradeWebSocket: UpgradeWebSocket
}

export type WorkspaceRuntimeRouteAuthBoundary =
  | "relay-host-auth"
  | "loopback-only"
  | "private-network-host-guard"
  | "private-network-dev-unsafe"
export type WorkspaceRuntimeServiceExposure = {
  source: "loopback" | "driver-service-url"
  access: "private" | "public" | "driver-authenticated" | "unknown"
  driver?: string
  fallbackAccess?: "private" | "public" | "driver-authenticated" | "unknown"
  note?: string
}

export type WorkspaceRuntimeServerOptions = {
  relayHostAuth?: RelayHostAuthOptions
  hostTunnel?: WorkspaceRelayHostTunnelOptions
  configToken?: string
  managementAuth?: WorkspaceRuntimeManagementAuth
  managementTarget?: WorkspaceRuntimeManagementTarget
  opencodeUrl?: string
  opencodeHeaders?: HeadersInit
  /**
   * Injected opencode transport (peer of `opencodeUrl`). When supplied, the host
   * rides this handler instead of building a URL — used by embedded compositions.
   */
  opencodeRequest?: OpenCodeRequestFn
  piModelBackend?: PiModelBackendResolver
  harness?: RuntimeRunner
  opencodeCompat?: boolean
  target?: WorkspaceTarget
  storeRoot?: string
  serviceExposure?: WorkspaceRuntimeServiceExposure
  exposure?: WorkspaceRuntimeExposure
  /**
   * Host-supplied CORS origin policy. When provided, it replaces the kit
   * default (`workspaceRuntimeCorsOrigin`, loopback-only, no product domains).
   * Hosts that need a product whitelist supply it here.
   */
  corsOrigin?: WorkspaceRuntimeCorsOrigin
}

type ListenPolicyEnv = {
  [key: string]: string | undefined
  WORKSPACE_RUNTIME_HOST?: string | undefined
  WORKSPACE_RUNTIME_ALLOW_UNAUTHENTICATED_NON_LOOPBACK?: string | undefined
  WORKSPACE_RUNTIME_DISABLE_CORS?: string | undefined
}

export const DEFAULT_WORKSPACE_RUNTIME_HOSTNAME = "127.0.0.1"

export function workspaceRuntimeListenHostname(env: ListenPolicyEnv = process.env) {
  const hostname = runtimeEnvText(env, "WORKSPACE_RUNTIME_HOST")
  return hostname ? hostname : DEFAULT_WORKSPACE_RUNTIME_HOSTNAME
}

export function isLoopbackHostname(hostname: string) {
  const value = hostname.trim().toLowerCase()
  return value === "localhost"
    || value === "127.0.0.1"
    || value === "::1"
    || value === "[::1]"
}

export function assertWorkspaceRuntimeListenPolicy(
  options: WorkspaceRuntimeServerOptions,
  hostname: string,
  env: ListenPolicyEnv = process.env,
) {
  if (isLoopbackHostname(hostname)) return
  if (options.relayHostAuth || options.exposure?.kind === "relay") return
  if (options.exposure?.kind === "private-network" && options.exposure.protection.kind === "host-guard") return
  if (runtimeEnvText(env, "WORKSPACE_RUNTIME_ALLOW_UNAUTHENTICATED_NON_LOOPBACK") === "1") {
    console.warn(
      "[workspace-runtime] WARN  allowing unauthenticated non-loopback listen because WORKSPACE_RUNTIME_ALLOW_UNAUTHENTICATED_NON_LOOPBACK=1",
    )
    return
  }
  throw new Error(
    `Refusing to listen on non-loopback host ${hostname} without relay-host auth. `
    + "Set WORKSPACE_RUNTIME_HOST to a loopback host, configure relay-host auth, or set "
    + "WORKSPACE_RUNTIME_ALLOW_UNAUTHENTICATED_NON_LOOPBACK=1 only behind trusted private-network controls.",
  )
}

function enabled(input: string | undefined) {
  return ["1", "true", "yes", "on"].includes(input?.trim().toLowerCase() ?? "")
}

function roundedMs(value: number) {
  return Math.round(value * 100) / 100
}

function appendServerTiming(input: string | null, name: string, durationMs: number) {
  const value = `${name};dur=${roundedMs(durationMs)}`
  return input ? `${input}, ${value}` : value
}

/**
 * A host-supplied CORS origin policy. Returns the origin to allow (echoed back
 * as `access-control-allow-origin`) or `undefined` to deny. Product-specific
 * origin whitelists (e.g. a host's own product-domain allowlist) are a host
 * DECISION and live in the host, never in the kit.
 */
export type WorkspaceRuntimeCorsOrigin = (
  origin: string,
  exposure: WorkspaceRuntimeExposure,
) => string | undefined

function loopbackCorsOrigin(origin: string) {
  if (origin.startsWith("http://localhost:")) return origin
  if (origin.startsWith("http://127.0.0.1:")) return origin
}

/**
 * Kit default CORS policy: loopback-only origins (`http://localhost:*`,
 * `http://127.0.0.1:*`) on loopback exposure, nothing on any other exposure.
 * Contains no product domains — hosts inject their own whitelist via
 * `WorkspaceRuntimeServerOptions.corsOrigin`.
 */
export function workspaceRuntimeCorsOrigin(exposure: WorkspaceRuntimeExposure, origin: string | undefined) {
  if (!origin) return undefined
  if (exposure.kind === "loopback") return loopbackCorsOrigin(origin)
  return undefined
}

export function workspaceRuntimeRouteAuthBoundary(
  options: Pick<WorkspaceRuntimeServerOptions, "exposure" | "relayHostAuth">,
  hostname = workspaceRuntimeListenHostname(),
  env: ListenPolicyEnv = process.env,
): WorkspaceRuntimeRouteAuthBoundary {
  if (options.exposure?.kind === "relay") return "relay-host-auth"
  if (options.exposure?.kind === "private-network") {
    return options.exposure.protection.kind === "host-guard"
      ? "private-network-host-guard"
      : "private-network-dev-unsafe"
  }
  if (options.relayHostAuth) return "relay-host-auth"
  if (
    !isLoopbackHostname(hostname)
    && enabled(runtimeEnvText(env, "WORKSPACE_RUNTIME_ALLOW_UNAUTHENTICATED_NON_LOOPBACK"))
  ) return "private-network-dev-unsafe"
  return "loopback-only"
}

type ServiceExposureEnv = {
  [key: string]: string | undefined
  WORKSPACE_RUNTIME_SERVICE_EXPOSURE_SOURCE?: string | undefined
  WORKSPACE_RUNTIME_SERVICE_EXPOSURE_ACCESS?: string | undefined
  WORKSPACE_RUNTIME_SERVICE_EXPOSURE_DRIVER?: string | undefined
  WORKSPACE_RUNTIME_SERVICE_EXPOSURE_FALLBACK_ACCESS?: string | undefined
  WORKSPACE_RUNTIME_SERVICE_EXPOSURE_NOTE?: string | undefined
}

function serviceExposureAccess(input: string | undefined) {
  const value = input?.trim()
  return value === "private" || value === "public" || value === "driver-authenticated" || value === "unknown"
    ? value
    : undefined
}

export function workspaceRuntimeServiceExposureFromEnv(env: ServiceExposureEnv = process.env): WorkspaceRuntimeServiceExposure {
  const access = serviceExposureAccess(runtimeEnvText(env, "WORKSPACE_RUNTIME_SERVICE_EXPOSURE_ACCESS"))
  const fallbackAccess = serviceExposureAccess(runtimeEnvText(env, "WORKSPACE_RUNTIME_SERVICE_EXPOSURE_FALLBACK_ACCESS"))
  const driver = runtimeEnvText(env, "WORKSPACE_RUNTIME_SERVICE_EXPOSURE_DRIVER")
  const note = runtimeEnvText(env, "WORKSPACE_RUNTIME_SERVICE_EXPOSURE_NOTE")
  const source = runtimeEnvText(env, "WORKSPACE_RUNTIME_SERVICE_EXPOSURE_SOURCE") === "driver-service-url"
    ? "driver-service-url"
    : "loopback"
  return {
    source,
    access: access ?? (source === "loopback" ? "private" : "unknown"),
    ...(driver ? { driver } : {}),
    ...(fallbackAccess ? { fallbackAccess } : {}),
    ...(note ? { note } : {}),
  }
}

export function workspaceRuntimeServerPort(server: { address?: () => unknown }, fallback: number) {
  const address = server.address?.()
  return address && typeof address === "object" && "port" in address && typeof address.port === "number"
    ? address.port
    : fallback
}

export async function waitForWorkspaceRuntimeServerPort(
  server: { address?: () => unknown; once?: (event: "listening", listener: () => void) => unknown },
  fallback: number,
) {
  const current = workspaceRuntimeServerPort(server, fallback)
  if (current !== 0 || fallback !== 0) return current
  if (!server.once) return current
  await new Promise<void>((resolve) => {
    server.once?.("listening", resolve)
  })
  return workspaceRuntimeServerPort(server, fallback)
}

type WorkspaceRuntimeDrainOptions = {
  server: { close(): unknown }
  runtime: { host: { dispose(): unknown } }
  directory: string
  drainTimeoutMs: number
  hostTunnel?: WorkspaceRelayHostTunnel
  processDispose?: (directory: string) => Promise<void>
  ptyDispose?: () => Promise<void>
}

type WorkspaceRuntimeShutdownReason = NodeJS.Signals | "unhandledRejection" | "uncaughtException"

async function drainStep(errors: unknown[], run: () => unknown | Promise<unknown>) {
  try {
    await run()
  } catch (err) {
    errors.push(err)
  }
}

export async function drainWorkspaceRuntime(options: WorkspaceRuntimeDrainOptions) {
  options.server.close()
  options.hostTunnel?.close()

  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => {
        const errors: unknown[] = []
        await drainStep(errors, () => (options.processDispose ?? ProcessManager.dispose)(options.directory))
        await drainStep(errors, () => (options.ptyDispose ?? Pty.dispose)())
        await drainStep(errors, () => options.runtime.host.dispose())
        if (errors.length) {
          throw new AggregateError(errors, "Workspace runtime drain failed")
        }
      })(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, options.drainTimeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export function createWorkspaceRuntimeShutdownHandler(options: {
  drainTimeoutMs: () => number
  drain: (drainTimeoutMs: number) => Promise<void>
  exit: (code: number) => void
  log?: Pick<typeof console, "error" | "log">
}) {
  const log = options.log ?? console
  let draining = false
  let exitCode = 0

  // Expected route/process failures should be handled at their owner boundary.
  // These process-level handlers are last-resort fatal paths: drain the
  // runtime-owned resources, then exit non-zero so a supervisor can restart.
  return async (reason: WorkspaceRuntimeShutdownReason, cause?: unknown) => {
    const fatal = reason === "unhandledRejection" || reason === "uncaughtException"
    exitCode = Math.max(exitCode, fatal ? 1 : 0)
    if (draining) return
    draining = true

    const drainTimeoutMs = options.drainTimeoutMs()
    if (fatal) {
      log.error(`[workspace-runtime] fatal ${reason}; draining for restart (timeout ${drainTimeoutMs}ms)`, cause)
    } else {
      log.log(`[workspace-runtime] received ${reason}, draining (timeout ${drainTimeoutMs}ms)`)
    }

    try {
      await options.drain(drainTimeoutMs)
    } catch (err) {
      log.error("[workspace-runtime] drain error", err)
    }
    options.exit(exitCode)
  }
}

function runtimeDiagnostics(host: Host, options: WorkspaceRuntimeServerOptions) {
  const target = options.target
  const dir = target?.directory ?? workspaceDir()
  const rows = ProcessManager.list(dir)
  const detail = host.detail()
  return {
    ok: detail.healthStatus === "ok",
    status: detail.state,
    healthStatus: detail.healthStatus,
    service: "workspace-runtime",
    workspaceId: target?.workspaceId ?? workspaceId(),
    directory: dir,
    profile: host.capabilities().profile,
    routeAuthBoundary: workspaceRuntimeRouteAuthBoundary(options),
    serviceExposure: options.serviceExposure ?? workspaceRuntimeServiceExposureFromEnv(),
    exposure: options.exposure ? { kind: exposureBoundaryName(options.exposure) } : undefined,
    controlPlane: {
      enabled: false,
      state: "disabled",
      consecutiveFailures: 0,
    },
    capabilities: host.capabilities(),
    agentType: detail.harness.id,
    harness: detail.harness,
    acpBinary: detail.harness.id === "opencode" ? null : detail.harness.connection?.kind === "process" ? detail.harness.connection.binary ?? null : null,
    model: null,
    error: detail.error || null,
    harnessHealth: detail.harnessHealth,
    configApply: detail.configApply,
    ptyCount: Pty.list().length,
    processCount: rows.length,
    activeProcessCount: rows.filter((item) => item.status !== "idle" && item.status !== "stopped").length,
  }
}

function runtimeLiveness(host: Host, options: WorkspaceRuntimeServerOptions) {
  const detail = host.detail()
  return {
    ok: detail.state !== "error",
    status: detail.state,
    service: "workspace-runtime",
    routeAuthBoundary: workspaceRuntimeRouteAuthBoundary(options),
    serviceExposure: options.serviceExposure ?? workspaceRuntimeServiceExposureFromEnv(),
    exposure: options.exposure ? { kind: exposureBoundaryName(options.exposure) } : undefined,
  }
}

export function createWorkspaceRuntimeApp(options: WorkspaceRuntimeServerOptions = {}): WorkspaceRuntimeApp {
  assertWorkspaceRuntimeExposure({
    exposure: options.exposure,
    hostname: workspaceRuntimeListenHostname(),
    isLoopbackHostname,
    env: process.env,
  })
  const host = createWorkspaceHost({
    ...(options.opencodeUrl ? { opencodeUrl: options.opencodeUrl } : {}),
    ...(options.opencodeHeaders ? { opencodeHeaders: options.opencodeHeaders } : {}),
    ...(options.opencodeRequest ? { opencodeRequest: options.opencodeRequest } : {}),
    ...(options.piModelBackend ? { piModelBackend: options.piModelBackend } : {}),
    ...(options.harness ? { harness: options.harness } : {}),
    ...(options.opencodeCompat !== undefined ? { opencodeCompat: options.opencodeCompat } : {}),
    ...(options.target ? { target: options.target } : {}),
    ...(options.storeRoot ? { storeRoot: options.storeRoot } : {}),
  })

  const app = new Hono()

  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  app.use("*", async (c, next) => {
    const startedAt = performance.now()
    await next()
    c.header("server-timing", appendServerTiming(c.res.headers.get("server-timing"), "runtime-total", performance.now() - startedAt))
    const traceId = c.req.header("x-claxedo-trace-id")
    if (traceId) c.header("x-claxedo-trace-id", traceId)
  })
  app.use("*", createWorkspaceRuntimeExposureMiddleware(options.exposure!))

  if (options.target) {
    app.use("*", async (_c, next) => withWorkspaceTarget(options.target!, next))
  }

  if (!enabled(runtimeEnvText(process.env, "WORKSPACE_RUNTIME_DISABLE_CORS"))) {
    const corsOrigin = options.corsOrigin
    app.use(
      cors({
        origin: (origin) =>
          corsOrigin
            ? (origin ? corsOrigin(origin, options.exposure!) : undefined)
            : workspaceRuntimeCorsOrigin(options.exposure!, origin),
      }),
    )
  }

  app.get("/global/health", (c) => {
    const detail = runtimeDiagnostics(host, options)
    return c.json({ ...detail, healthy: detail.ok })
  })
  const relayHostAuthOptions = options.relayHostAuth ?? (options.exposure?.kind === "relay" ? options.exposure.auth : undefined)
  if (relayHostAuthOptions) {
    const relayHostAuth = createRelayHostAuthMiddleware({
      ...relayHostAuthOptions,
      trustedDirectTokenForRequest: async (input) =>
        (!!options.configToken
          && input.token === options.configToken
          && (
            input.method === "GET" && input.path === WorkspaceRuntimeRoutes.health
          ))
        || await relayHostAuthOptions.trustedDirectTokenForRequest?.(input)
        || false,
    }) as MiddlewareHandler
    app.use("*", async (c, next) => {
      if (
        c.req.method === "POST"
        && c.req.path === WorkspaceRuntimeRoutes.config
        && c.req.header(WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER)?.trim()
      ) {
        return await next()
      }
      return await relayHostAuth(c, next)
    })
  }
  app.route("/", ConfigRoutes((snapshot) => host.apply(snapshot), {
    ...(options.managementAuth ? { managementAuth: options.managementAuth } : {}),
    ...(options.managementTarget ? { managementTarget: options.managementTarget } : {}),
  }))
  // Tools-only execution surface for central sessions. Inherits the exposure
  // and relay-host auth middleware registered above — the same workspace-level
  // auth boundary as every other /api/wr route (no per-session scoping).
  app.route(WorkspaceRuntimeRoutes.sessionEnv, SessionEnvRoutes())

  app.get(WorkspaceRuntimeRoutes.health, (c) =>
    c.json(runtimeLiveness(host, options)),
  )

  app.get(WorkspaceRuntimeRoutes.capabilities, (c) => c.json(host.capabilities()))
  host.mount(app, { core: { upgradeWebSocket }, exposure: options.exposure! })

  return { app, host, injectWebSocket, upgradeWebSocket }
}

export type WorkspaceRuntimeLifecycleOptions = {
  /**
   * Opt in to process-global signal/exit ownership. When false (the default),
   * `startServer` registers ZERO process listeners and never calls
   * `process.exit` — a library must not claim the host process. The drain
   * handler + wiring are still constructed (the drain *ordering* is a kit
   * mechanism); only the `process.on(...)`/`process.exit` registrations are
   * conditional. Hosts that own their process (host-entry, the relay e2e
   * fixture) pass `{ signals: true }`.
   */
  signals?: boolean
}

export function startServer(
  port = 3002,
  options: WorkspaceRuntimeServerOptions = {},
  lifecycle: WorkspaceRuntimeLifecycleOptions = {},
) {
  const hostname = workspaceRuntimeListenHostname()
  assertWorkspaceRuntimeExposure({
    exposure: options.exposure,
    hostname,
    isLoopbackHostname,
    env: process.env,
  })
  assertWorkspaceRuntimeListenPolicy(options, hostname)
  const runtime = createWorkspaceRuntimeApp(options)

  const server = serve({
    fetch: runtime.app.fetch,
    port,
    hostname,
  })
  runtime.injectWebSocket(server)
  const hostTunnel = options.hostTunnel ? startWorkspaceRelayHostTunnel(options.hostTunnel) : undefined

  void waitForWorkspaceRuntimeServerPort(server, port).then((actualPort) =>
    setupAgentHooks({ port: actualPort })
  ).catch((cause: unknown) => {
    console.error(`[workspace-runtime] WARN  failed to setup agent hooks`, cause)
  })

  const shutdown = createWorkspaceRuntimeShutdownHandler({
    drainTimeoutMs: () => Number(runtimeEnvText(process.env, "WORKSPACE_RUNTIME_DRAIN_TIMEOUT_MS") ?? 10_000),
    drain: (drainTimeoutMs) =>
      // Stop accepting work, detach external routing, stop heartbeats,
      // then clean up workspace-owned processes, PTYs, and adapter state.
      // Race with the drain timeout so a hung cleanup cannot strand the
      // process during supervisor shutdown or fatal-error restart.
      drainWorkspaceRuntime({
        server,
        runtime,
        directory: options.target?.directory ?? workspaceDir(),
        drainTimeoutMs,
        ...(hostTunnel ? { hostTunnel } : {}),
      }),
    exit: (code) => process.exit(code),
  })

  // Process-global claims are a host DECISION, not a kit mechanism. Only
  // register signal/exit handlers when the host explicitly opts in.
  if (lifecycle.signals) {
    process.on("SIGTERM", () => { void shutdown("SIGTERM") })
    process.on("SIGINT", () => { void shutdown("SIGINT") })
    process.on("unhandledRejection", (reason) => { void shutdown("unhandledRejection", reason) })
    process.on("uncaughtException", (err) => { void shutdown("uncaughtException", err) })
  }

  return server
}
