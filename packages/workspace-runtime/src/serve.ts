import { serve } from "@hono/node-server"
import { setupAgentHooks } from "./agent-hooks"
import { runtimeEnvText } from "./env"
import { assertWorkspaceRuntimeExposure } from "./exposure"
import { isLoopbackHostname } from "@claxedo/helpers"
import { Pty } from "./pty/index"
import {
  assertWorkspaceRuntimeListenPolicy,
  createWorkspaceRuntimeApp,
  workspaceRuntimeListenHostname,
  type WorkspaceRuntimeServerOptions,
} from "./server"
import { startWorkspaceRelayHostTunnel } from "./workspace-relay-host-tunnel"

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
  drainTimeoutMs: number
  // Draining only closes the tunnel, so it asks for no more than that —
  // matching `server` above. A full `WorkspaceRelayHostTunnel` satisfies it.
  hostTunnel?: { close(): unknown }
  ptyDispose?: () => Promise<void>
  hostDrain?: () => Promise<void> | void
}

type WorkspaceRuntimeShutdownReason = NodeJS.Signals | "unhandledRejection" | "uncaughtException"

async function drainStep(errors: unknown[], run: () => unknown) {
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
        await drainStep(errors, () => (options.ptyDispose ?? Pty.dispose)())
        await drainStep(errors, () => options.runtime.host.dispose())
        await drainStep(errors, () => options.hostDrain?.())
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

/**
 * Listens once the host's engines are prepared: a control plane counts the
 * runtime ready when its health answers, so the person's first call never
 * queues behind an engine boot that holds the event loop.
 */
export async function startServer(
  port: number,
  options: WorkspaceRuntimeServerOptions,
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
  await runtime.host.prepare()

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
      // then clean up workspace-owned PTYs and adapter state.
      // Race with the drain timeout so a hung cleanup cannot strand the
      // process during supervisor shutdown or fatal-error restart.
      drainWorkspaceRuntime({
        server,
        runtime,
        drainTimeoutMs,
        ...(hostTunnel ? { hostTunnel } : {}),
        ...(options.onDrain ? { hostDrain: options.onDrain } : {}),
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
