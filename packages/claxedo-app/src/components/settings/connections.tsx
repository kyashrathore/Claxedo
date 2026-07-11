// Connections settings section: lists integrations from the claxedo-server
// connections host (/api/claxedo/integrations) with per-integration status,
// connect/reconnect/disconnect/re-verify actions, and the connect dialog.
// The token endpoint under this route family is host-internal and is never
// called from the UI.
import { createSignal, For, onMount, Show, type Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Tag } from "@opencode-ai/ui/tag"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { authFetch, getClaxedoServerUrl } from "@/shared/data/api"
import { DialogConnectIntegration } from "../dialogs/connect-integration"
import {
  createConnectionsStore,
  type ConnectionInfo,
  type ConnectionsRequest,
  type IntegrationInfo,
} from "./connections-logic"

/** All UI traffic goes through the authenticated fetch helper, same-origin to the control plane. */
const integrationsRequest: ConnectionsRequest = (path, init) =>
  authFetch(new URL(`/api/claxedo/integrations${path}`, getClaxedoServerUrl()).toString(), init)

const STATUS_LABEL: Record<ConnectionInfo["status"], string> = {
  connected: "Connected",
  degraded: "Degraded",
  broken: "Broken",
}

function StatusChip(props: { status: ConnectionInfo["status"] }) {
  return (
    <span class="inline-flex items-center gap-1.5">
      <span
        class="shrink-0 size-2 rounded-full"
        classList={{
          "bg-surface-success-strong": props.status === "connected",
          "bg-surface-warning-strong": props.status === "degraded",
          "bg-surface-critical-strong": props.status === "broken",
        }}
      />
      <span
        class="text-12-medium"
        classList={{
          "text-text-base": props.status === "connected",
          "text-icon-warning-base": props.status === "degraded",
          "text-icon-critical-base": props.status === "broken",
        }}
      >
        {STATUS_LABEL[props.status]}
      </span>
    </span>
  )
}

export const SettingsConnections: Component = () => {
  const dialog = useDialog()
  const store = createConnectionsStore({ request: integrationsRequest })
  const [confirming, setConfirming] = createSignal<string | undefined>(undefined)
  const [busy, setBusy] = createSignal<string | undefined>(undefined)

  onMount(() => void store.load())

  const openConnect = (integration: IntegrationInfo, scope?: ConnectionInfo["scope"]) => {
    dialog.show(() => (
      <DialogConnectIntegration
        integration={integration}
        request={integrationsRequest}
        onConnected={() => store.load()}
        personalScopeEnabled={store.state.personalScopeEnabled}
        initialScope={scope}
      />
    ))
  }

  const disconnect = async (integration: IntegrationInfo, connection: ConnectionInfo) => {
    setConfirming(undefined)
    setBusy(connection.id)
    const result = await store.disconnect(connection.id)
    setBusy(undefined)
    if (result.ok) {
      showToast({ variant: "success", icon: "circle-check", title: `${integration.name} disconnected` })
      return
    }
    showToast({ variant: "error", title: result.error ?? "Disconnect failed" })
  }

  const reverify = async (integration: IntegrationInfo, connection: ConnectionInfo) => {
    setBusy(connection.id)
    const result = await store.reverify(connection.id)
    setBusy(undefined)
    if (result.ok) {
      showToast({ variant: "success", icon: "circle-check", title: `${integration.name} verified` })
      return
    }
    showToast({ variant: "error", title: `${integration.name} verification failed`, description: result.error })
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">Connections</h2>
          <p class="text-13-regular text-text-weak">
            Connect external tools like Notion, GitHub, and Atlassian so agents can use them.
          </p>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <div class="flex flex-col gap-1" data-component="connections-section">
          <Show when={store.state.error}>
            {(error) => <div class="py-2 text-13-regular text-icon-critical-base">{error()}</div>}
          </Show>
          <div class="bg-surface-raised-base px-4 rounded-lg">
            <Show
              when={store.state.integrations.length > 0}
              fallback={
                <div class="py-4 text-14-regular text-text-weak">
                  {store.state.loading ? "Loading connections…" : "No integrations available."}
                </div>
              }
            >
              <For each={store.state.integrations}>
                {(integration) => {
                  const connections = () => store.connectionsFor(integration.id)
                  return (
                    <div class="flex flex-col gap-3 min-h-16 py-3 border-b border-border-weak-base last:border-none">
                      <div class="flex flex-wrap items-center justify-between gap-4">
                        <div class="flex flex-col gap-1 min-w-0">
                          <span class="text-14-medium text-text-strong">{integration.name}</span>
                          <div class="flex flex-wrap items-center gap-1">
                            <For each={integration.capabilities}>{(capability) => <Tag>{capability}</Tag>}</For>
                          </div>
                        </div>
                        <Button size="small" variant="secondary" icon="plus-small" onClick={() => openConnect(integration)}>
                          {connections().length > 0 ? "Add connection" : "Connect"}
                        </Button>
                      </div>
                      <Show when={connections().length > 0}>
                        <div class="flex flex-col gap-2">
                          <For each={connections()}>
                            {(connection) => {
                              const status = () => connection.status
                              return (
                                <div class="flex flex-wrap items-center justify-between gap-4 rounded-md bg-surface-base px-3 py-2">
                                  <div class="flex flex-col gap-1 min-w-0">
                                    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                                      <Show when={store.state.personalScopeEnabled}>
                                        <Tag>{connection.scope === "personal" ? "Only me" : "Team"}</Tag>
                                      </Show>
                                      <StatusChip status={status()} />
                                      <Show when={connection.accountLabel}>
                                        {(label) => <span class="text-12-regular text-text-weak">{label()}</span>}
                                      </Show>
                                    </div>
                                  </div>
                                  <div class="flex items-center gap-2 shrink-0">
                                    <Show when={status() === "degraded"}>
                                      <Button
                                        size="small"
                                        variant="secondary"
                                        disabled={busy() === connection.id}
                                        onClick={() => void reverify(integration, connection)}
                                      >
                                        Re-verify
                                      </Button>
                                    </Show>
                                    <Show when={status() === "degraded" || status() === "broken"}>
                                      <Button size="small" variant="secondary" onClick={() => openConnect(integration, connection.scope)}>
                                        Reconnect
                                      </Button>
                                    </Show>
                                    <Show
                                      when={confirming() === connection.id}
                                      fallback={
                                        <Button
                                          size="small"
                                          variant="ghost"
                                          disabled={busy() === connection.id}
                                          onClick={() => setConfirming(connection.id)}
                                        >
                                          Disconnect
                                        </Button>
                                      }
                                    >
                                      <span class="text-12-regular text-text-weak">Disconnect?</span>
                                      <Button
                                        size="small"
                                        variant="primary"
                                        disabled={busy() === connection.id}
                                        onClick={() => void disconnect(integration, connection)}
                                      >
                                        Confirm
                                      </Button>
                                      <Button size="small" variant="ghost" onClick={() => setConfirming(undefined)}>
                                        Cancel
                                      </Button>
                                    </Show>
                                  </div>
                                </div>
                              )
                            }}
                          </For>
                        </div>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}
