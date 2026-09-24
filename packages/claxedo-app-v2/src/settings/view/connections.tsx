import { createSignal, For, Show } from "solid-js"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { useServer, type Connection, type ConnectionScope, type Integration, type IntegrationsCatalog } from "@/server"
import type { HarnessConnectionRef } from "@claxedo/agent-runtime-contract"
import { showToast, Tag } from "@/ui"
import { Button } from "@opencode-ai/ui/button"
import { useTranslator } from "@/i18n"
import { loadAgentConnections, removeAgentConnection, verifyFailedMessage } from "../connections"
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
  const server = useServer()
  const catalog = useQuery(() => server.queries.integrations.catalog())
  const agents = useQuery(() => ({ queryKey: ["settings", "agent-connections"], queryFn: loadAgentConnections, staleTime: Infinity }))
  const [connecting, setConnecting] = createSignal<Connecting>()
  const [busy, setBusy] = createSignal<string>()
  const reverify = async (id: string) => {
    const outcome = await server.integrations.reverify(id)
    if (!outcome.ok) throw new Error(verifyFailedMessage(outcome.verifyReason))
  }

  const act = async (id: string, task: () => Promise<void>, done: string) => {
    setBusy(id)
    try {
      await task()
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
                {(integration) => (
                  <IntegrationBlock
                    integration={integration}
                    catalog={data()}
                    connecting={connecting()}
                    busy={busy()}
                    onConnecting={setConnecting}
                    onReverify={(entry) => void act(entry.id, () => reverify(entry.id), `${integration.name} verified`)}
                    onDisconnect={(entry) => void act(entry.id, () => server.integrations.disconnect(entry.id), `${integration.name} disconnected`)}
                  />
                )}
              </For>
            </SettingsList>
          )}
        </Show>
      </SettingsGroup>
    </div>
  )
}

type Connecting = { integration: Integration; scope?: ConnectionScope }

function IntegrationBlock(props: {
  readonly integration: Integration
  readonly catalog: IntegrationsCatalog
  readonly connecting: Connecting | undefined
  readonly busy: string | undefined
  readonly onConnecting: (next: Connecting | undefined) => void
  readonly onReverify: (entry: Connection) => void
  readonly onDisconnect: (entry: Connection) => void
}) {
  const t = useTranslator(dictionary)
  const connections = () => props.catalog.connections.filter((entry) => entry.integrationId === props.integration.id)
  return (
    <div class="settings-fields" data-integration={props.integration.id}>
      <div class="settings-inline">
        <span class="settings-row-title">{props.integration.name}</span>
        <For each={props.integration.capabilities}>{(capability) => <Tag>{capability}</Tag>}</For>
        <span style={{ flex: 1 }} />
        <Button size="small" variant="secondary" icon="plus-small" onClick={() => props.onConnecting({ integration: props.integration })}>
          {connections().length > 0 ? t("settings.connections.add") : t("settings.common.connect")}
        </Button>
      </div>
      <Show when={props.connecting?.integration.id === props.integration.id ? props.connecting : undefined}>
        {(open) => (
          <ConnectForm
            integration={props.integration}
            personalScopeEnabled={props.catalog.personalScopeEnabled}
            initialScope={open().scope}
            onConnected={() => props.onConnecting(undefined)}
            onCancel={() => props.onConnecting(undefined)}
          />
        )}
      </Show>
      <For each={connections()}>
        {(entry) => (
          <ConnectionRow
            connection={entry}
            personalScope={props.catalog.personalScopeEnabled}
            busy={props.busy === entry.id}
            onReconnect={() => props.onConnecting({ integration: props.integration, scope: entry.scope })}
            onReverify={() => props.onReverify(entry)}
            onDisconnect={() => props.onDisconnect(entry)}
          />
        )}
      </For>
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
          <Button size="small" variant="secondary" disabled={props.busy} onClick={() => props.onReverify()}>{t("settings.connections.reverify")}</Button>
        </Show>
        <Show when={props.connection.status !== "connected"}>
          <Button size="small" variant="secondary" onClick={() => props.onReconnect()}>{t("settings.connections.reconnect")}</Button>
        </Show>
        <Show when={confirming()} fallback={<Button size="small" variant="ghost" disabled={props.busy} onClick={() => setConfirming(true)}>{t("settings.common.disconnect")}</Button>}>
          <span class="settings-row-description">{t("settings.connections.disconnectConfirm")}</span>
          <Button size="small" variant="primary" disabled={props.busy} onClick={() => { setConfirming(false); props.onDisconnect() }}>{t("settings.connections.confirm")}</Button>
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
        <SettingsNote>{props.rows?.status === "unsupported" && props.rows.reason === "operator_local_configuration" ? t("settings.connections.agents.operator") : props.rows?.status === "unsupported" ? props.rows.reason : ""}</SettingsNote>
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
