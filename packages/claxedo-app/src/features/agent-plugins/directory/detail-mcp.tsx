import { createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Switch } from "@opencode-ai/ui/switch"
import type { PluginCandidate, PluginCatalog, PluginToolGroup } from "../api"
import { AGENT_PLUGIN_CONNECTION_STATUS, type AgentPluginConnectionSummary } from "../connections"
import { ROW } from "./chrome"
import { OverflowItem, OverflowMenu } from "./overflow-menu"
import { connectionFor, isBuiltIn, toolGroups } from "./view"

type ConnectRequest = {
  serverName: string
  integrationId: string
  scope: "personal" | "team"
  issuer?: string
}

/** A server's dot: connected is quiet, anything else asks for a hand. */
function ServerDot(props: { connection?: AgentPluginConnectionSummary; required: boolean }) {
  return (
    <span
      class="size-1.5 shrink-0 rounded-full"
      classList={{
        "bg-surface-success-strong": props.connection?.status === "connected",
        "bg-surface-warning-strong": props.connection?.status === "degraded" || (!props.connection && props.required),
        "bg-surface-critical-strong": props.connection?.status === "broken",
        "bg-surface-raised-stronger": !props.connection && !props.required,
      }}
    />
  )
}

/**
 * The built-in's rows: one tool group, its switch, and the tools it registers.
 *
 * A group is what the built-in has instead of a server to authenticate — the
 * connection a third-party server needs is, here, the user's consent — so it
 * takes the same row with a switch where the Connect button sits.
 */
function PluginToolGroupRows(props: {
  groups: readonly PluginToolGroup[]
  pending: boolean
  onToolGroup: (group: PluginToolGroup, enabled: boolean) => void
}) {
  return (
    <>
      <For each={props.groups}>
        {(group) => (
          <div class={`${ROW} mb-1.5 flex items-start gap-2`} data-agent-plugin-tool-group={group.id}>
            <div class="min-w-0 flex-1">
              <div class="truncate text-12-medium text-text-strong">{group.id}</div>
              <div class="break-words text-12-mono text-text-weaker">{group.tools.join(", ")}</div>
            </div>
            <Switch
              checked={group.enabled}
              disabled={props.pending}
              hideLabel
              onChange={(enabled: boolean) => props.onToolGroup(group, enabled)}
            >
              {group.id}
            </Switch>
          </div>
        )}
      </For>
      <p class="text-11-regular text-text-weaker">Changes apply to sessions started from now.</p>
    </>
  )
}

/**
 * The pane's MCP list: one row per server, one visible action per row.
 *
 * Connecting is the action a row exists for; disconnecting and every
 * organization-scoped variant are rarer and move behind the row's "…" so the
 * list stays scannable when a plugin ships four servers.
 */
function PluginServerRows(props: {
  plugin: PluginCandidate
  catalog: PluginCatalog
  connections?: readonly AgentPluginConnectionSummary[]
  connectionsLoading: boolean
  connectionsError?: unknown
  onRetryConnections?: () => void
  onConnect: (input: ConnectRequest) => void
  onDisconnect: (connection: AgentPluginConnectionSummary) => void
}) {
  const [issuers, setIssuers] = createSignal<Record<string, string>>({})
  const retained = () => Boolean(props.plugin.retainedDigest)

  return (
    <>
      <For each={props.plugin.mcpServers}>
        {(server) => {
          const auth = server.authentication
          if (auth.state !== "oauth") {
            const message = auth.state === "public"
              ? "No connection required"
              : auth.state === "local"
                ? "Runs locally"
                : auth.state === "harness"
                  ? "Authentication is handled by the selected harness"
                  : `Unavailable: ${("reason" in auth ? auth.reason : "unknown").replaceAll("_", " ")}`
            return (
              <div class={`${ROW} mb-1.5 flex items-center gap-2`}>
                <ServerDot required={false} />
                <div class="min-w-0 flex-1">
                  <div class="truncate text-12-medium text-text-strong">{server.name}</div>
                  <div class="text-11-regular text-text-weaker">{server.type}</div>
                </div>
                <span class="shrink-0 text-11-regular text-text-weak">{message}</span>
              </div>
            )
          }
          const key = `${props.plugin.pluginInstanceId}\0${server.name}`
          const issuer = () => auth.issuers?.length ? issuers()[key] : undefined
          const issuerRequired = () => Boolean(auth.issuers?.length && !issuer())
          const personal = () => connectionFor(props.connections, auth.integrationId, "personal")
          const organization = () => connectionFor(props.connections, auth.integrationId, "team")
          const effective = () => personal() ?? organization()
          const connect = (scope: "personal" | "team") => props.onConnect({
            serverName: server.name,
            integrationId: auth.integrationId,
            scope,
            ...(issuer() ? { issuer: issuer()! } : {}),
          })
          return (
            <div class={`${ROW} mb-1.5 grid gap-2`}>
              <div class="flex items-center gap-2">
                <ServerDot connection={effective()} required />
                <div class="min-w-0 flex-1">
                  <div class="truncate text-12-medium text-text-strong">{server.name}</div>
                  <div class="text-11-regular text-text-weaker">
                    {server.type} · OAuth
                    <Show when={effective()}>
                      {(connection) => (
                        <>
                          {" · "}
                          {connection().scope === "personal" ? "Personal" : "Organization"}{" "}
                          {AGENT_PLUGIN_CONNECTION_STATUS[connection().status]}
                        </>
                      )}
                    </Show>
                    <Show when={!effective()}>
                      {" · "}
                      {retained() ? "Connection required" : "Enable the plugin before connecting"}
                    </Show>
                  </div>
                </div>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={!retained() || props.connectionsLoading || issuerRequired()}
                  onClick={() => connect("personal")}
                >
                  {personal() ? "Reconnect" : "Connect"}
                </Button>
                <OverflowMenu label={`More actions for ${server.name}`}>
                  <Show when={personal()}>
                    {(connection) => (
                      <OverflowItem onSelect={() => props.onDisconnect(connection())}>Disconnect</OverflowItem>
                    )}
                  </Show>
                  <Show when={props.catalog.canManageOrganizationConnections}>
                    <OverflowItem
                      disabled={!retained() || props.connectionsLoading || issuerRequired()}
                      onSelect={() => connect("team")}
                    >
                      {organization() ? "Reconnect organization (admin)" : "Connect for organization (admin)"}
                    </OverflowItem>
                    <Show when={organization()}>
                      {(connection) => (
                        <OverflowItem onSelect={() => props.onDisconnect(connection())}>
                          Disconnect organization (admin)
                        </OverflowItem>
                      )}
                    </Show>
                  </Show>
                </OverflowMenu>
              </div>
              <Show when={auth.issuers?.length}>
                <label class="grid gap-1 text-11-regular text-text-weaker">
                  <span>Authorization server</span>
                  <select
                    aria-label={`${server.name} authorization server`}
                    class="rounded-md border border-border-weak-base bg-background-base px-2 py-1 text-12-regular text-text-base"
                    value={issuer() ?? ""}
                    onChange={(event) => setIssuers((current) => ({ ...current, [key]: event.currentTarget.value }))}
                  >
                    <option value="">Choose an authorization server</option>
                    <For each={auth.issuers}>{(option) => <option value={option}>{option}</option>}</For>
                  </select>
                </label>
              </Show>
            </div>
          )
        }}
      </For>
      <Show when={props.connectionsError}>
        <p class="text-12-regular text-text-weak">
          Connection status is unavailable right now — the control plane could not be reached.
          <Show when={props.onRetryConnections}>
            {" "}
            <button type="button" class="text-12-medium text-text-strong underline-offset-2 hover:underline" onClick={() => props.onRetryConnections?.()}>Retry</button>
          </Show>
        </p>
      </Show>
    </>
  )
}

/**
 * What the pane lists under one plugin's servers: OAuth rows for a plugin that
 * ships servers, tool-group rows for the built-in.
 *
 * A Show, not a branch in the caller: the pane is not remounted when the user
 * picks another card, so the choice has to stay reactive to `plugin`.
 */
export function PluginMcpServers(props: {
  plugin: PluginCandidate
  catalog: PluginCatalog
  connections?: readonly AgentPluginConnectionSummary[]
  connectionsLoading: boolean
  connectionsError?: unknown
  onRetryConnections?: () => void
  onConnect: (input: ConnectRequest) => void
  onDisconnect: (connection: AgentPluginConnectionSummary) => void
  pending: boolean
  onToolGroup: (group: PluginToolGroup, enabled: boolean) => void
}) {
  return (
    <Show
      when={isBuiltIn(props.plugin)}
      fallback={
        <PluginServerRows
          plugin={props.plugin}
          catalog={props.catalog}
          connections={props.connections}
          connectionsLoading={props.connectionsLoading}
          connectionsError={props.connectionsError}
          onRetryConnections={props.onRetryConnections}
          onConnect={props.onConnect}
          onDisconnect={props.onDisconnect}
        />
      }
    >
      <PluginToolGroupRows
        groups={toolGroups(props.plugin)}
        pending={props.pending}
        onToolGroup={props.onToolGroup}
      />
    </Show>
  )
}
