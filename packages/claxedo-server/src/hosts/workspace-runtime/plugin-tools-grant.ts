import type { McpServiceGrant } from "@claxedo/mcp/tool-group"
import { controlPlaneOrigin } from "@claxedo/server-core/hosts/workspace-runtime/control-plane-origin"
import { workspaceRuntimePluginToolsGrantToken } from "@claxedo/server-core/hosts/workspace-runtime/env"
import { expiryOf, halfLifeRenewal, nodeRenewalTimers, type RenewalOutcome, type RenewalTimers } from "@claxedo/server-core/hosts/workspace-runtime/half-life-renewal"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"

const PLUGIN_TOOLS_GRANT_RENEWAL_PATH = "/api/claxedo/app-plugins/tools/grant"

export type WorkspaceRuntimePluginToolsGrant = Readonly<{
  /** The grant while it is live and the control plane has not refused it; nothing after, so a new MCP session serves no plugin tools. */
  current(): McpServiceGrant | undefined
  start(): void
  stop(): void
}>

export type WorkspaceRuntimePluginToolsGrantOptions = Readonly<{
  fetch?: typeof fetch
  now?: () => number
  timers?: RenewalTimers
  log?: { info(message: string, extra?: Record<string, unknown>): void; warn(message: string, extra?: Record<string, unknown>): void }
}>

/**
 * The app plugin tools grant this cloud root was launched with, as the
 * first-party MCP mount's `app-plugin-tools` service: every listing and tool
 * call goes to the control plane with it, which reads again on each one what
 * the grant's plugins may still do for this root.
 *
 * Absent when the control plane minted none, because no app plugin's tools are
 * on for the root's project, or when the control plane cannot be located.
 * A grant lives at most an hour and a root longer, so at half its life it is
 * traded for a fresh one, retried with backoff until it expires. A refusal
 * ends it for good: the plugins were turned off, or the workspace has another
 * owner, and only a new launch can restore it.
 */
export function workspaceRuntimePluginToolsGrant(
  env: NodeJS.ProcessEnv = process.env,
  options: WorkspaceRuntimePluginToolsGrantOptions = {},
): WorkspaceRuntimePluginToolsGrant | undefined {
  const initial = workspaceRuntimePluginToolsGrantToken(env)
  const origin = controlPlaneOrigin(env)
  if (!initial || !origin) return undefined
  const send = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const log = options.log ?? Log.create({ service: "claxedo-plugin-tools-grant" })
  let token = initial
  let expiresAt = expiryOf(initial)
  let ended = false

  async function renew(): Promise<RenewalOutcome> {
    let response: Response
    try {
      response = await send(new Request(new URL(PLUGIN_TOOLS_GRANT_RENEWAL_PATH, origin), { method: "POST", headers: { authorization: `Bearer ${token}` } }))
    } catch (cause) {
      log.warn("plugin_tools.grant.renewal_failed", { error: cause instanceof Error ? cause.message : String(cause) })
      return { kind: "failed" }
    }
    if (response.status === 401 || response.status === 403) {
      ended = true
      log.warn("plugin_tools.grant.withdrawn", { status: response.status })
      return { kind: "refused" }
    }
    const body: unknown = response.ok ? await response.json().catch(() => undefined) : undefined
    const next = body !== null && typeof body === "object" && "token" in body && typeof body.token === "string" ? body.token : undefined
    const nextExpiry = next ? expiryOf(next) : undefined
    if (!next || nextExpiry === undefined) {
      log.warn("plugin_tools.grant.renewal_failed", { status: response.status })
      return { kind: "failed" }
    }
    token = next
    expiresAt = nextExpiry
    log.info("plugin_tools.grant.renewed", { expiresAt })
    return { kind: "renewed", expiresAt: nextExpiry }
  }

  const renewal = halfLifeRenewal({
    renew,
    lapsed: () => {
      ended = true
      log.warn("plugin_tools.grant.lapsed", { expiresAt })
    },
    now,
    timers: options.timers ?? nodeRenewalTimers(),
  })
  const live = () => !ended && (expiresAt === undefined || now() < expiresAt)
  const grant: McpServiceGrant = {
    operations: ["call"],
    fetch: async (path, init) => {
      const request = new Request(new URL(path, origin), init)
      request.headers.set("authorization", `Bearer ${token}`)
      return await send(request)
    },
  }
  return {
    current: () => (live() ? grant : undefined),
    start: () => {
      if (expiresAt !== undefined && live()) renewal.track(expiresAt)
    },
    stop: renewal.stop,
  }
}
