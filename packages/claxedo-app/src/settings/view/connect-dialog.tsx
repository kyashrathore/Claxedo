import { createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
import { useI18n, useTranslator } from "@/i18n"
import { openExternal } from "@/lib/external-link"
import { useServer, type ConnectionScope, type Integration, type IntegrationConnectInput } from "@/server"
import { FormDialog, SegmentedControl, SegmentedControlItem, Tabs, TextField, useDialog } from "@/ui"
import { connectError, connectMachine, createConnectForm, grantError, integrationPurpose, type ConnectForm, type ConnectState } from "../connections"
import { settingsDictionary } from "../i18n"

type Mode = "key" | "oauth"

type OauthWaiting = Extract<ConnectState, { kind: "oauthWaiting" }>

function ScopeRow(props: { readonly scope: ConnectionScope; readonly onScope: (scope: ConnectionScope) => void }) {
  const t = useTranslator(settingsDictionary)
  return (
    <div class="settings-connect-scope">
      <span class="settings-row-description">{t("settings.connections.scope")}</span>
      <SegmentedControl class="segmented-control-v2--fit" aria-label={t("settings.connections.scope")} value={props.scope} onChange={(value) => (value === "org" || value === "personal") && props.onScope(value)}>
        <SegmentedControlItem value="org">{t("settings.connections.scope.org")}</SegmentedControlItem>
        <SegmentedControlItem value="personal">{t("settings.connections.scope.personal")}</SegmentedControlItem>
      </SegmentedControl>
    </div>
  )
}

function OauthPanel(props: { readonly name: string; readonly waiting: OauthWaiting | undefined }) {
  const t = useTranslator(settingsDictionary)
  return (
    <Show when={props.waiting} fallback={<p class="settings-row-description">{t("settings.connections.oauthHint", { name: props.name })}</p>}>
      {(current) => (
        <div class="settings-fields" role="status">
          <Show when={current().userCode}>{(code) => <code class="settings-code">{t("settings.connections.code", { code: code() })}</code>}</Show>
          <a class="settings-row-description" href={current().url} target="_blank" rel="noopener">{t("settings.connections.open")}</a>
        </div>
      )}
    </Show>
  )
}

function KeyPanel(props: { readonly integration: Integration; readonly form: ConnectForm; readonly setForm: SetStoreFunction<ConnectForm> }) {
  const t = useTranslator(settingsDictionary)
  return (
    <div class="settings-connect-key">
      <For each={props.integration.prompts}>
        {(prompt) => (
          <TextField
            type={prompt.secret ? "password" : "text"}
            autocomplete="off"
            label={prompt.label}
            placeholder={prompt.placeholder ?? ""}
            description={prompt.createUrl ? <a href={prompt.createUrl} target="_blank" rel="noopener">{t("settings.connections.createKey", { host: new URL(prompt.createUrl).host })}</a> : undefined}
            value={prompt.secret ? props.form.secret : (props.form.fields[prompt.id] ?? "")}
            onChange={(value) => (prompt.secret ? props.setForm("secret", value) : props.setForm("fields", prompt.id, value))}
          />
        )}
      </For>
    </div>
  )
}

function MethodTabs(props: { readonly mode: Mode; readonly onMode: (mode: Mode) => void; readonly oauth: JSX.Element; readonly keyFields: JSX.Element }) {
  const t = useTranslator(settingsDictionary)
  return (
    <Tabs class="settings-connect-method" value={props.mode} onChange={(value) => (value === "key" || value === "oauth") && props.onMode(value)}>
      <Tabs.List aria-label={t("settings.connections.method")}>
        <Tabs.Trigger value="oauth">{t("settings.connections.method.oauth")}</Tabs.Trigger>
        <Tabs.Trigger value="key">{t("settings.connections.method.key")}</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="oauth" forceMount class="settings-connect-panel">
        {props.oauth}
      </Tabs.Content>
      <Tabs.Content value="key" forceMount class="settings-connect-panel">
        {props.keyFields}
      </Tabs.Content>
    </Tabs>
  )
}

export function DialogConnectIntegration(props: { readonly integration: Integration; readonly personalScopeEnabled: boolean; readonly initialScope?: ConnectionScope }) {
  const t = useTranslator(settingsDictionary)
  const i18n = useI18n()
  const server = useServer()
  const dialog = useDialog()
  const state = connectMachine()
  const [form, setForm] = createConnectForm(props.initialScope ?? "org")
  const keyOffered = () => props.integration.methods.includes("key") && props.integration.prompts.length > 0
  const oauthOffered = () => props.integration.methods.includes("oauth")
  const [mode, setMode] = createSignal<Mode>(oauthOffered() ? "oauth" : "key")
  const [alive, setAlive] = createSignal(true)
  onCleanup(() => setAlive(false))

  const connectInput = (confirmReplace: boolean): IntegrationConnectInput => {
    const options = { ...(props.personalScopeEnabled ? { scope: form.scope } : {}), ...(confirmReplace ? { confirmReplace: true } : {}) }
    if (mode() === "oauth") return { ...options, method: "oauth" }
    const fields = Object.fromEntries(props.integration.prompts.filter((prompt) => !prompt.secret).map((prompt) => [prompt.id, form.fields[prompt.id] ?? ""]))
    return { ...options, method: "key", secret: form.secret, fields }
  }
  const submit = async () => {
    const replacing = state.state().kind === "confirmReplace"
    if (mode() === "key" && !form.secret.trim()) return state.send({ type: "failed", error: t("settings.connections.secretRequired") })
    state.send(replacing ? { type: "confirm" } : { type: "submit", mode: mode() })
    const result = await server.integrations.connect(props.integration.id, connectInput(replacing))
    if (!alive()) return
    if (result.kind === "failed") return state.send(result.reason === "exists" ? { type: "exists" } : { type: "failed", error: connectError(result) })
    if (result.kind === "connected") return dialog.close()
    state.send({ type: "authorize", url: result.grant.url, ...(result.grant.userCode ? { userCode: result.grant.userCode } : {}) })
    openExternal(result.grant.url)
    const outcome = await server.integrations.awaitGrant(result.grant, alive)
    if (outcome.kind === "connected") dialog.close()
    else if (outcome.kind === "failed") state.send({ type: "failed", error: grantError(outcome.reason) })
  }
  const busy = () => state.state().kind === "submitting" || state.state().kind === "oauthWaiting"
  const error = () => {
    const current = state.state()
    return current.kind === "form" ? current.error : undefined
  }
  const waiting = () => {
    const current = state.state()
    return current.kind === "oauthWaiting" ? current : undefined
  }
  const oauth = () => <OauthPanel name={props.integration.name} waiting={waiting()} />
  const keyFields = () => <KeyPanel integration={props.integration} form={form} setForm={setForm} />

  return (
    <FormDialog
      title={t("settings.connections.dialogTitle", { name: props.integration.name })}
      description={integrationPurpose(t, props.integration.capabilities, i18n.intlTag())}
      submitLabel={t(state.state().kind === "confirmReplace" ? "settings.connections.replaceConfirm" : "settings.common.connect")}
      busyLabel={waiting() ? t("settings.connections.waiting") : t("settings.connections.connecting")}
      cancelLabel={t("settings.common.cancel")}
      busy={busy()}
      error={error()}
      onSubmit={() => void submit()}
      onCancel={() => dialog.close()}
    >
      <Show when={keyOffered() && oauthOffered()} fallback={mode() === "oauth" ? oauth() : keyFields()}>
        <MethodTabs mode={mode()} onMode={(next) => { setMode(next); state.send({ type: "cancel" }) }} oauth={oauth()} keyFields={keyFields()} />
      </Show>
      <Show when={state.state().kind === "confirmReplace"}>
        <p class="settings-row-description" role="status">{t("settings.connections.replace")}</p>
      </Show>
      <Show when={props.personalScopeEnabled}>
        <ScopeRow scope={form.scope} onScope={(scope) => setForm("scope", scope)} />
      </Show>
    </FormDialog>
  )
}
