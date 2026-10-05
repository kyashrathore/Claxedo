import { createSignal, For, Show } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { toAppError, useServer, type AppError, type Connection, type ConnectionScope, type Integration, type IntegrationsCatalog } from "@/server"
import type { HarnessConnectionRef, HarnessConnectionsCatalog } from "@claxedo/agent-runtime-contract"
import { showToast, Button, Icon, useDialog } from "@/ui"
import { useErrorCopy, useI18n, useTranslator } from "@/i18n"
import { connectionReadinessKey, integrationPurpose, verifyFailedMessage } from "../connections"
import { settingsDictionary, type SettingsKey } from "../i18n"
import { DialogConnectIntegration } from "./connect-dialog"
import { SettingsEmpty, SettingsGroup, SettingsIntro, SettingsList, SettingsNote } from "./section"

const STATUS_KEY = {
  connected: "settings.connections.status.connected",
  degraded: "settings.connections.status.degraded",
  broken: "settings.connections.status.broken",
} as const satisfies Record<Connection["status"], SettingsKey>

const STATUS_TONE = { connected: "success", degraded: "warning", broken: "danger" } as const

export function ConnectionsSection() {
  const t = useTranslator(settingsDictionary)
  const errorCopy = useErrorCopy("connections")
  const server = useServer()
  const offered = () => server.capabilities()?.features.connections === true
  const catalog = useQuery(() => ({ ...server.queries.integrations.catalog(), enabled: offered() }))
  const agents = useQuery(() => server.queries.agentConnections.list())
  const dialog = useDialog()
  const connect = (next: Connecting) => dialog.show(() => <DialogConnectIntegration integration={next.integration} personalScopeEnabled={catalog.data?.personalScopeEnabled === true} {...(next.scope ? { initialScope: next.scope } : {})} />)
  const [busy, setBusy] = createSignal<string>()
  const reverify = async (id: string) => {
    const outcome = await server.integrations.reverify(id)
    return outcome.ok ? undefined : verifyFailedMessage(outcome.verifyReason)
  }
  const settle = (task: () => Promise<void>) => async () => {
    await task()
    return undefined
  }

  const act = async (id: string, task: () => Promise<string | undefined>, done: string) => {
    setBusy(id)
    try {
      const refused = await task()
      showToast(refused ? { title: t("settings.common.requestFailed"), description: refused } : { title: done })
    } catch (error) {
      showToast({ title: t("settings.common.requestFailed"), description: errorCopy(toAppError(error)).message })
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div class="settings-body">
      <SettingsIntro description={t("settings.connections.description")} />
      <AgentConnections rows={agents.data} error={agents.error} onRemove={(row) => void act(row.connectionId, settle(() => server.agentConnections.remove(row.connectionId)), `${row.label} removed`)} busy={busy()} />
      <Show when={!offered() && agents.data?.status !== "supported"}>
        <SettingsEmpty>{t("settings.connections.nothing")}</SettingsEmpty>
      </Show>
      <Show when={offered()}>
      <SettingsGroup title={t("settings.connections.integrations")}>
        <Show when={catalog.error}>{(error) => <SettingsNote tone="danger">{errorCopy(error()).message}</SettingsNote>}</Show>
        <Show when={offered() && catalog.data} fallback={<Show when={offered()}><SettingsEmpty>{catalog.isPending ? t("settings.common.loading") : t("settings.connections.integrations.empty")}</SettingsEmpty></Show>}>
          {(data) => (
            <SettingsList>
              <For each={data().integrations}>
                {(integration) => (
                  <IntegrationBlock
                    integration={integration}
                    catalog={data()}
                    busy={busy()}
                    onConnecting={connect}
                    onReverify={(entry) => void act(entry.id, () => reverify(entry.id), `${integration.name} verified`)}
                    onDisconnect={(entry) => void act(entry.id, settle(() => server.integrations.disconnect(entry.id)), `${integration.name} disconnected`)}
                  />
                )}
              </For>
            </SettingsList>
          )}
        </Show>
      </SettingsGroup>
      </Show>
    </div>
  )
}

type Connecting = { integration: Integration; scope?: ConnectionScope }

function IntegrationBlock(props: {
  readonly integration: Integration
  readonly catalog: IntegrationsCatalog
  readonly busy: string | undefined
  readonly onConnecting: (next: Connecting) => void
  readonly onReverify: (entry: Connection) => void
  readonly onDisconnect: (entry: Connection) => void
}) {
  const t = useTranslator(settingsDictionary)
  const i18n = useI18n()
  const connections = () => props.catalog.connections.filter((entry) => entry.integrationId === props.integration.id)
  return (
    <div class="settings-fields" data-integration={props.integration.id}>
      <div class="settings-inline">
        <div class="settings-row-text">
          <span class="settings-row-title">{props.integration.name}</span>
          <Show when={integrationPurpose(t, props.integration.capabilities, i18n.intlTag())}>{(purpose) => <span class="settings-row-description">{purpose()}</span>}</Show>
        </div>
        <Button size="small" variant="neutral" onClick={() => props.onConnecting({ integration: props.integration })}>
          <Icon name="plus-small" size="small" />
          {connections().length > 0 ? t("settings.connections.add") : t("settings.connections.connectMore")}
        </Button>
      </div>
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
  const t = useTranslator(settingsDictionary)
  const [confirming, setConfirming] = createSignal(false)
  return (
    <div class="settings-account" data-connection={props.connection.id} data-status={props.connection.status}>
      <span class="settings-dot" data-tone={STATUS_TONE[props.connection.status]} aria-hidden="true" />
      <div class="settings-account-text">
        <span class="settings-row-title">{t(STATUS_KEY[props.connection.status])}</span>
        <span class="settings-row-description">
          <Show when={props.personalScope}>{t(props.connection.scope === "personal" ? "settings.connections.scope.personal" : "settings.connections.scope.org")} · </Show>
          {props.connection.accountLabel ?? ""}
        </span>
      </div>
      <div class="settings-account-actions">
        <Show when={props.connection.status === "degraded"}>
          <Button size="small" variant="neutral" disabled={props.busy} onClick={() => props.onReverify()}>{t("settings.connections.reverify")}</Button>
        </Show>
        <Show when={props.connection.status !== "connected"}>
          <Button size="small" variant="neutral" onClick={() => props.onReconnect()}>{t("settings.connections.reconnect")}</Button>
        </Show>
        <Show when={confirming()} fallback={<Button size="small" variant="ghost" disabled={props.busy} onClick={() => setConfirming(true)}>{t("settings.common.disconnect")}</Button>}>
          <span class="settings-row-description">{t("settings.connections.disconnectConfirm")}</span>
          <Button size="small" variant="contrast" disabled={props.busy} onClick={() => { setConfirming(false); props.onDisconnect() }}>{t("settings.connections.confirm")}</Button>
          <Button size="small" variant="ghost" onClick={() => setConfirming(false)}>{t("settings.common.cancel")}</Button>
        </Show>
      </div>
    </div>
  )
}

function AgentConnections(props: {
  readonly rows: HarnessConnectionsCatalog | undefined
  readonly error: AppError | null
  readonly busy: string | undefined
  readonly onRemove: (row: HarnessConnectionRef) => void
}) {
  const t = useTranslator(settingsDictionary)
  const errorCopy = useErrorCopy("connections")
  const server = useServer()
  const rows = () => (props.rows?.status === "supported" && props.rows.connections.length > 0 ? props.rows.connections : undefined)
  return (
    <>
      <Show when={props.error}>{(error) => <SettingsNote tone="danger">{errorCopy(error()).message}</SettingsNote>}</Show>
      <Show when={rows()}>
        {(list) => (
          <SettingsGroup title={t("settings.connections.agents")} description={t("settings.connections.agents.description", { machine: server.capabilities()?.servingMachine?.name ?? t("settings.connections.agents.machineFallback") })}>
            <SettingsList>
              <For each={list()}>
                {(row) => (
                  <div class="settings-account" data-agent-connection={row.connectionId}>
                    <div class="settings-account-text">
                      <span class="settings-row-title">{row.label}</span>
                      <span class="settings-row-description">{t(connectionReadinessKey(row.readiness))}</span>
                    </div>
                    <Button size="small" variant="ghost" disabled={props.busy === row.connectionId} onClick={() => props.onRemove(row)}>{t("settings.common.remove")}</Button>
                  </div>
                )}
              </For>
            </SettingsList>
          </SettingsGroup>
        )}
      </Show>
    </>
  )
}
