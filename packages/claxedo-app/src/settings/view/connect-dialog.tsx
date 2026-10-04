import { createSignal, For, onCleanup, Show } from "solid-js"
import { useTranslator } from "@/i18n"
import { openExternal } from "@/lib/external-link"
import { useServer, type ConnectionScope, type Integration, type IntegrationConnectInput } from "@/server"
import { FormDialog, SegmentedControl, SegmentedControlItem, TextField, useDialog } from "@/ui"
import { connectError, connectMachine, createConnectForm, grantError } from "../connections"
import { settingsDictionary } from "../i18n"

type Mode = "key" | "oauth"

function ScopeChoice(props: { readonly scope: ConnectionScope; readonly onScope: (scope: ConnectionScope) => void }) {
  const t = useTranslator(settingsDictionary)
  return (
    <div class="settings-fields">
      <span class="settings-row-title">{t("settings.connections.scope")}</span>
      <SegmentedControl class="segmented-control-v2--fit" aria-label={t("settings.connections.scope")} value={props.scope} onChange={(value) => (value === "org" || value === "personal") && props.onScope(value)}>
        <SegmentedControlItem value="org">{t("settings.connections.scope.org")}</SegmentedControlItem>
        <SegmentedControlItem value="personal">{t("settings.connections.scope.personal")}</SegmentedControlItem>
      </SegmentedControl>
    </div>
  )
}

function ModeChoice(props: { readonly mode: Mode; readonly onMode: (mode: Mode) => void }) {
  const t = useTranslator(settingsDictionary)
  return (
    <SegmentedControl class="segmented-control-v2--fit" aria-label={t("settings.connections.method")} value={props.mode} onChange={(value) => (value === "key" || value === "oauth") && props.onMode(value)}>
      <SegmentedControlItem value="oauth">{t("settings.connections.method.oauth")}</SegmentedControlItem>
      <SegmentedControlItem value="key">{t("settings.connections.method.key")}</SegmentedControlItem>
    </SegmentedControl>
  )
}

export function DialogConnectIntegration(props: { readonly integration: Integration; readonly personalScopeEnabled: boolean; readonly initialScope?: ConnectionScope }) {
  const t = useTranslator(settingsDictionary)
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
  const submitLabel = () => {
    if (state.state().kind === "confirmReplace") return t("settings.connections.replaceConfirm")
    return t(mode() === "oauth" ? "settings.connections.oauth" : "settings.common.connect")
  }

  return (
    <FormDialog
      title={t("settings.connections.dialogTitle", { name: props.integration.name })}
      description={t(mode() === "oauth" ? "settings.connections.dialogOauth" : "settings.connections.dialogKey", { name: props.integration.name })}
      submitLabel={submitLabel()}
      busyLabel={waiting() ? t("settings.connections.waiting") : t("settings.connections.connecting")}
      cancelLabel={t("settings.common.cancel")}
      busy={busy()}
      error={error()}
      onSubmit={() => void submit()}
      onCancel={() => dialog.close()}
    >
      <Show when={keyOffered() && oauthOffered()}>
        <ModeChoice mode={mode()} onMode={(next) => { setMode(next); state.send({ type: "cancel" }) }} />
      </Show>
      <Show when={props.personalScopeEnabled}>
        <ScopeChoice scope={form.scope} onScope={(scope) => setForm("scope", scope)} />
      </Show>
      <Show when={mode() === "key"}>
        <For each={props.integration.prompts}>
          {(prompt) => (
            <TextField
              type={prompt.secret ? "password" : "text"}
              autocomplete="off"
              label={prompt.label}
              placeholder={prompt.placeholder ?? ""}
              description={prompt.createUrl ? <a href={prompt.createUrl} target="_blank" rel="noopener">{t("settings.connections.createKey", { host: new URL(prompt.createUrl).host })}</a> : undefined}
              value={prompt.secret ? form.secret : (form.fields[prompt.id] ?? "")}
              onChange={(value) => (prompt.secret ? setForm("secret", value) : setForm("fields", prompt.id, value))}
            />
          )}
        </For>
      </Show>
      <Show when={state.state().kind === "confirmReplace"}>
        <p class="settings-row-description" role="status">{t("settings.connections.replace")}</p>
      </Show>
      <Show when={waiting()}>
        {(current) => (
          <div class="settings-fields" role="status">
            <Show when={current().userCode}>{(code) => <code class="settings-code">{t("settings.connections.code", { code: code() })}</code>}</Show>
            <a class="settings-row-description" href={current().url} target="_blank" rel="noopener">{t("settings.connections.open")}</a>
          </div>
        )}
      </Show>
    </FormDialog>
  )
}
