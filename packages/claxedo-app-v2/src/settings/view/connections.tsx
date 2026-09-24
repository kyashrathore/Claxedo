import { createSignal, For, Show } from "solid-js"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import type { HarnessConnectionRef } from "@claxedo/agent-runtime-contract"
import { Button, showToast, Tag } from "@/ui"
import { useTranslator } from "@/i18n"
import {
  disconnectConnection,
  loadAgentConnections,
  loadConnections,
  removeAgentConnection,
  reverifyConnection,
  type Connection,
  type ConnectionScope,
  type Integration,
} from "../connections"
import { dictionary, type Keys } from "../i18n"
import { ConnectForm } from "./connect-form"
import { SettingsEmpty, SettingsGroup, SettingsIntro, SettingsList, SettingsNote } from "./section"

const STATUS_KEY = {
  connected: "settings.connections.status.connected",
  degraded: "settings.connections.status.degraded",
  broken: "settings.connections.status.broken",
} as const satisfies Record<Connection["status"], Keys>

const STATUS_TONE = { connected: "success", degraded: "warning", broken: "danger" } as const

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function ConnectionsSection() {
  const t = useTranslator(dictionary)
  const queryClient = useQueryClient()
  const catalog = useQuery(() => ({ queryKey: ["settings", "connections"], queryFn: loadConnections, staleTime: Infinity }))
  const agents = useQuery(() => ({ queryKey: ["settings", "agent-connections"], queryFn: loadAgentConnections, staleTime: Infinity }))
  const [connecting, setConnecting] = createSignal<{ integration: Integration; scope?: ConnectionScope }>()
  const [busy, setBusy] = createSignal<string>()
  const reload = () => queryClient.invalidateQueries({ queryKey: ["settings", "connections"] })

  const act = async (id: string, task: () => Promise<void>, done: string) => {
    setBusy(id)
    try {
      await task()
      await reload()
      showToast({ title: done })
    } catch (error) {
      showToast({ title: t("settings.common.requestFailed"), description: reason(error) })
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div class="settings-body" data-component="settings-connections">
      <SettingsIntro description={t("settings.connections.description")} />
      <AgentConnections rows={agents.data} error={agents.error} loading={agents.isPending} onRemove={(row) => void act(row.connectionId, () => removeAgentConnection(row.connectionId).then(() => queryClient.invalidateQueries({ queryKey: ["settings", "agent-connections"] })), `${row.label} removed`)} busy={busy()} />
      <SettingsGroup title={t("settings.connections.integrations")}>
        <Show when={catalog.error}>{(error) => <SettingsNote tone="danger">{reason(error())}</SettingsNote>}</Show>
        <Show when={catalog.data} fallback={<SettingsEmpty>{catalog.isPending ? t("settings.common.loading") : t("settings.connections.integrations.empty")}</SettingsEmpty>}>
          {(data) => (
            <SettingsList>
              <For each={data().integrations}>
                {(integration) => {
                  const connections = () => data().connections.filter((entry) => entry.integrationId === integration.id)
                  return (
                    <div class="settings-fields" data-integration={integration.id}>
                      <div class="settings-inline">
                        <span class="settings-row-title">{integration.name}</span>
                        <For each={integration.capabilities}>{(capability) => <Tag>{capability}</Tag>}</For>
                        <span style={{ flex: 1 }} />
                        <Button size="small" icon="plus-small" onClick={() => setConnecting({ integration })}>
                          {connections().length > 0 ? t("settings.connections.add") : t("settings.common.connect")}
                        </Button>
                      </div>
                      <Show when={connecting()?.integration.id === integration.id ? connecting() : undefined}>
                        {(open) => (
                          <ConnectForm
                            integration={integration}
                            personalScopeEnabled={data().personalScopeEnabled}
                            initialScope={open().scope}
                            onConnected={() => { setConnecting(undefined); void reload() }}
                            onCancel={() => setConnecting(undefined)}
                          />
                        )}
                      </Show>
                      <For each={connections()}>
                        {(entry) => (
                          <ConnectionRow
                            connection={entry}
                            personalScope={data().personalScopeEnabled}
                            busy={busy() === entry.id}
                            onReconnect={() => setConnecting({ integration, scope: entry.scope })}
                            onReverify={() => void act(entry.id, () => reverifyConnection(entry.id), `${integration.name} verified`)}
                            onDisconnect={() => void act(entry.id, () => disconnectConnection(entry.id), `${integration.name} disconnected`)}
                          />
                        )}
                      </For>
                    </div>
                  )
                }}
              </For>
            </SettingsList>
          )}
        </Show>
      </SettingsGroup>
    </div>
  )
}

function ConnectionRow(props: {
  readonly connection: Connection
  readonly personalScope: boolean
  readonly busy: boolean
  readonly onReconnect: () => void
  readonly onReverify: () => void
  readonly onDisconnect: () => void
}) {
  const t = useTranslator(dictionary)
  const [confirming, setConfirming] = createSignal(false)
  return (
    <div class="settings-account" data-connection={props.connection.id} data-status={props.connection.status}>
      <span class="settings-dot" data-tone={STATUS_TONE[props.connection.status]} aria-hidden="true" />
      <div class="settings-account-text">
        <span class="settings-row-title">{t(STATUS_KEY[props.connection.status])}</span>
        <span class="settings-row-description">
          <Show when={props.personalScope}>{t(props.connection.scope === "personal" ? "settings.connections.scope.personal" : "settings.connections.scope.team")} · </Show>
          {props.connection.accountLabel ?? ""}
        </span>
      </div>
      <div class="settings-account-actions">
        <Show when={props.connection.status === "degraded"}>
          <Button size="small" disabled={props.busy} onClick={() => props.onReverify()}>{t("settings.connections.reverify")}</Button>
        </Show>
        <Show when={props.connection.status !== "connected"}>
          <Button size="small" onClick={() => props.onReconnect()}>{t("settings.connections.reconnect")}</Button>
        </Show>
        <Show when={confirming()} fallback={<Button size="small" variant="ghost" disabled={props.busy} onClick={() => setConfirming(true)}>{t("settings.common.disconnect")}</Button>}>
          <span class="settings-row-description">{t("settings.connections.disconnectConfirm")}</span>
          <Button size="small" variant="danger" disabled={props.busy} onClick={() => { setConfirming(false); props.onDisconnect() }}>{t("settings.connections.confirm")}</Button>
          <Button size="small" variant="ghost" onClick={() => setConfirming(false)}>{t("settings.common.cancel")}</Button>
        </Show>
      </div>
    </div>
  )
}

function AgentConnections(props: {
  readonly rows: Awaited<ReturnType<typeof loadAgentConnections>> | undefined
  readonly error: unknown
  readonly loading: boolean
  readonly busy: string | undefined
  readonly onRemove: (row: HarnessConnectionRef) => void
}) {
  const t = useTranslator(dictionary)
  const supported = () => (props.rows?.status === "supported" ? props.rows.connections : undefined)
  return (
    <SettingsGroup title={t("settings.connections.agents")} description={t("settings.connections.agents.description")}>
      <Show when={props.error}>{(error) => <SettingsNote tone="danger">{reason(error())}</SettingsNote>}</Show>
      <Show when={props.rows?.status === "unsupported"}>
        <SettingsNote>{props.rows?.status === "unsupported" && props.rows.reason === "operator_local_configuration" ? t("settings.connections.agents.operator") : String(props.rows?.status === "unsupported" ? props.rows.reason : "")}</SettingsNote>
      </Show>
      <Show when={supported()}>
        {(rows) => (
          <SettingsList>
            <Show when={rows().length === 0}><SettingsNote>{t("settings.connections.agents.empty")}</SettingsNote></Show>
            <For each={rows()}>
              {(row) => (
                <div class="settings-account" data-agent-connection={row.connectionId}>
                  <div class="settings-account-text">
                    <span class="settings-row-title">{row.label}</span>
                    <span class="settings-row-description">{row.readiness}</span>
                  </div>
                  <Button size="small" variant="ghost" disabled={props.busy === row.connectionId} onClick={() => props.onRemove(row)}>{t("settings.common.remove")}</Button>
                </div>
              )}
            </For>
          </SettingsList>
        )}
      </Show>
      <Show when={props.loading && !props.rows}><SettingsNote>{t("settings.common.loading")}</SettingsNote></Show>
    </SettingsGroup>
  )
}
