import { Show, Suspense } from "solid-js"
import { SurfaceFallback } from "@/app/integrations/surface-fallback"
import type { AgentPluginContributionSet } from "./product-contributions"
import {
  AgentPluginCatalog,
  type AgentPluginConnectionPort,
  type AgentPluginConnectionSummary,
} from "@/features/agent-plugins/catalog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogConnectIntegration } from "@/app/dialogs/connect-integration"
import { authFetch, getClaxedoServerUrl, getDefaultBaseUrl } from "@/platform/api/api"
import { useAccountPort } from "@/platform/account/account-provider"
import type { AccountPort, HostedOperationName } from "@/platform/account/account-port"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { unsignedLocalFetch } from "@/platform/runtime/transport"
import { agentPluginApi } from "@/features/agent-plugins/api"
import { accountAgentPluginApi } from "./agent-plugin-account-api"

const browserConnectionsRequest = (path: string, init?: RequestInit) =>
  authFetch(new URL(`/api/claxedo/integrations${path}`, getClaxedoServerUrl()).toString(), init)

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function connectionSummary(value: unknown): AgentPluginConnectionSummary | undefined {
  if (!record(value)) return undefined
  const row = value
  if (
    typeof row.id !== "string"
    || typeof row.integrationId !== "string"
    || (row.scope !== "personal" && row.scope !== "team")
    || (row.status !== "connected" && row.status !== "degraded" && row.status !== "broken")
  ) return undefined
  return { id: row.id, integrationId: row.integrationId, scope: row.scope, status: row.status }
}

type StatusResult = { status: number; body?: unknown }

function statusResult(value: unknown): StatusResult {
  if (!record(value)
    || typeof value.status !== "number"
    || !Number.isSafeInteger(value.status)
    || value.status < 100
    || value.status > 599) throw new Error("Hosted operation returned an invalid response status")
  return { status: value.status, ...(Object.hasOwn(value, "body") ? { body: value.body } : {}) }
}

async function accountStatus(
  account: AccountPort,
  operation: HostedOperationName,
  input?: Record<string, unknown>,
) {
  return statusResult(await account.run(operation, input))
}

function errorMessage(result: StatusResult, label: string) {
  const body = record(result.body) ? result.body : undefined
  const nested = record(body?.error) ? body.error : undefined
  const detail = typeof nested?.message === "string"
    ? nested.message
    : typeof body?.code === "string"
      ? body.code
      : undefined
  return `${label} (${result.status}${detail ? `: ${detail}` : ""})`
}

function response(result: StatusResult) {
  return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
    status: result.status,
    headers: result.body === undefined ? undefined : { "content-type": "application/json" },
  })
}

function accountConnectionsRequest(account: AccountPort) {
  return async (path: string, init?: RequestInit) => {
    const connect = /^\/([^/]+)\/connect$/.exec(path)
    if (connect && init?.method === "POST") {
      const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined
      if (!record(body)) throw new Error("Connect request body is invalid")
      return response(await accountStatus(account, "connections.connect", {
        id: decodeURIComponent(connect[1]!),
        ...body,
      }))
    }
    const attempt = /^\/attempts\/([^/]+)$/.exec(path)
    if (attempt && (!init?.method || init.method === "GET")) {
      return response(await accountStatus(account, "connections.attempt", {
        state: decodeURIComponent(attempt[1]!),
      }))
    }
    throw new Error(`Unsupported Connections account operation: ${path}`)
  }
}

function CatalogSurface() {
  const dialog = useDialog()
  const account = useAccountPort()
  const platform = usePlatform()
  const baseUrl = getClaxedoServerUrl()
  // A signed-capable desktop build carries the hosted control-plane URL even
  // while the account is unsigned. Its local plugin authority still lives in
  // the sidecar bound during ServerGate startup; getDefaultBaseUrl() names that
  // canonical runtime binding before considering release environment URLs.
  const unsignedApi = agentPluginApi({ baseUrl: getDefaultBaseUrl(), request: unsignedLocalFetch })
  const browserSignedApi = agentPluginApi({ baseUrl, request: platform.fetch ?? authFetch })
  const desktopSignedApi = accountAgentPluginApi(account)
  const mode = () => account.state().status === "signed" ? "signed" as const : "unsigned" as const
  const desktopSigned = () => platform.platform === "desktop" && mode() === "signed"
  const connections: AgentPluginConnectionPort = {
    async load() {
      const result = desktopSigned()
        ? await accountStatus(account, "connections.list")
        : await browserConnectionsRequest("").then(async (result) => ({
            status: result.status,
            body: await result.json().catch(() => undefined) as unknown,
          }))
      const raw = result.body
      const body = record(raw) ? raw : undefined
      if (result.status < 200 || result.status >= 300) throw new Error(errorMessage(result, "Connections request failed"))
      return {
        connections: Array.isArray(body?.connections)
          ? body.connections.map(connectionSummary).filter((row): row is AgentPluginConnectionSummary => row !== undefined)
          : [],
      }
    },
    open(input) {
      void dialog.show(() => (
        <DialogConnectIntegration
          integration={{ id: input.integrationId, name: input.name, methods: ["oauth"], capabilities: ["mcp"] }}
          request={desktopSigned() ? accountConnectionsRequest(account) : browserConnectionsRequest}
          {...(input.issuer ? { oauthFields: { issuer: input.issuer } } : {})}
          onConnected={() => input.onConnected()}
          personalScopeEnabled
          teamScopeEnabled={input.teamScopeEnabled}
          initialScope={input.scope}
          openUrl={(url) => platform.openLink(url)}
        />
      ))
    },
    async disconnect(connectionId) {
      if (desktopSigned()) {
        const result = await accountStatus(account, "connections.disconnect", { id: connectionId })
        if ((result.status < 200 || result.status >= 300) && result.status !== 404) {
          throw new Error(errorMessage(result, "Disconnect failed"))
        }
        return
      }
      const result = await browserConnectionsRequest(`/connections/${encodeURIComponent(connectionId)}`, { method: "DELETE" })
      if (!result.ok && result.status !== 404) throw new Error(`Disconnect failed (${result.status})`)
    },
  }
  return (
    <Show when={account.state().status !== "pending"} fallback={<SurfaceFallback />}>
      <AgentPluginCatalog
        mode={mode()}
        api={mode() === "signed" ? (desktopSigned() ? desktopSignedApi : browserSignedApi) : unsignedApi}
        connections={mode() === "signed" ? connections : undefined}
      />
    </Show>
  )
}

/** Build-composed Agent Plugins UI. This module is the optional chunk boundary. */
export function agentPluginContributions(): AgentPluginContributionSet {
  return {
    contentSurfaces: [{
      id: "surface.content.agent-plugins",
      tier: "claxedo-first-party",
      surface: "marketplace",
      slot: "workbench",
      renderer: () => <Suspense fallback={<SurfaceFallback />}><CatalogSurface /></Suspense>,
    }],
  }
}
