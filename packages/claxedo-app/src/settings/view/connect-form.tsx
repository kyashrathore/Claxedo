import { createSignal, For, onCleanup, Show } from "solid-js"
import { Button, Select, TextField } from "@/ui"
import { useTranslator } from "@/i18n"
import { useServer, type ConnectionScope, type Integration, type IntegrationConnectInput } from "@/server"
import { connectError, connectMachine, createConnectForm, grantError } from "../connections"
import { settingsDictionary } from "../i18n"
import { openExternal } from "@/lib/external-link"

const SCOPES: readonly ConnectionScope[] = ["team", "personal"]

export function ConnectForm(props: {
  readonly integration: Integration
  readonly personalScopeEnabled: boolean
  readonly initialScope?: ConnectionScope
  readonly onConnected: () => void
  readonly onCancel: () => void
}) {
  const t = useTranslator(settingsDictionary)
  const server = useServer()
  const state = connectMachine()
  const [form, setForm] = createConnectForm(props.initialScope ?? "team")
  const [alive, setAlive] = createSignal(true)
  onCleanup(() => setAlive(false))
  const keyMethod = () => props.integration.methods.includes("key") && props.integration.prompts.length > 0
  const oauthMethod = () => props.integration.methods.includes("oauth")
  const scopeLabel = (scope: ConnectionScope) => t(scope === "personal" ? "settings.connections.scope.personal" : "settings.connections.scope.team")

  const connectInput = (mode: "key" | "oauth", confirmReplace: boolean): IntegrationConnectInput => {
    const options = { ...(props.personalScopeEnabled ? { scope: form.scope } : {}), ...(confirmReplace ? { confirmReplace: true } : {}) }
    if (mode === "oauth") return { ...options, method: "oauth" }
    const fields = Object.fromEntries(props.integration.prompts.filter((prompt) => !prompt.secret).map((prompt) => [prompt.id, form.fields[prompt.id] ?? ""]))
    return { ...options, method: "key", secret: form.secret, fields }
  }
  const submit = async (mode: "key" | "oauth", confirmReplace: boolean) => {
    if (mode === "key" && !form.secret.trim()) return state.send({ type: "failed", error: t("settings.connections.secretRequired") })
    state.send({ type: "submit", mode })
    const result = await server.integrations.connect(props.integration.id, connectInput(mode, confirmReplace))
    if (!alive()) return
    if (result.kind === "failed") return state.send(result.reason === "exists" ? { type: "exists" } : { type: "failed", error: connectError(result) })
    if (result.kind === "connected") return finish()
    state.send({ type: "authorize", url: result.grant.url, ...(result.grant.userCode ? { userCode: result.grant.userCode } : {}) })
    openExternal(result.grant.url)
    const outcome = await server.integrations.awaitGrant(result.grant, alive)
    if (outcome.kind === "connected") finish()
    else if (outcome.kind === "failed") state.send({ type: "failed", error: grantError(outcome.reason) })
  }
  const finish = () => {
    state.send({ type: "connected" })
    setForm({ fields: {}, secret: "" })
    props.onConnected()
  }
  const confirmReplace = () => {
    const current = state.state()
    if (current.kind === "confirmReplace") void submit(current.mode, true)
  }
  const busy = () => state.state().kind === "submitting" || state.state().kind === "oauthWaiting"
  const formError = () => {
    const current = state.state()
    return current.kind === "form" ? current.error : undefined
  }
  const waiting = () => {
    const current = state.state()
    return current.kind === "oauthWaiting" ? current : undefined
  }

  return (
    <form class="settings-fields" aria-label={`${t("settings.common.connect")} ${props.integration.name}`} onSubmit={(event) => { event.preventDefault(); void submit("key", false) }}>
      <Show when={props.personalScopeEnabled}>
        <Select aria-label="Scope" options={[...SCOPES]} current={form.scope} value={(scope) => scope} label={scopeLabel} onSelect={(scope) => scope && setForm("scope", scope)} variant="secondary" size="small" triggerVariant="settings" />
      </Show>
      <Show when={keyMethod()}>
        <For each={props.integration.prompts}>
          {(prompt) => (
            <TextField
              type={prompt.secret ? "password" : "text"}
              autocomplete="off"
              label={prompt.label}
              hideLabel
              placeholder={prompt.placeholder ?? prompt.label}
              value={prompt.secret ? form.secret : (form.fields[prompt.id] ?? "")}
              onChange={(value) => (prompt.secret ? setForm("secret", value) : setForm("fields", prompt.id, value))}
            />
          )}
        </For>
      </Show>
      <Show when={formError()}>{(error) => <p class="settings-note" data-tone="danger" role="alert">{error()}</p>}</Show>
      <Show when={state.state().kind === "confirmReplace"}>
        <div class="settings-inline" role="alertdialog" aria-label={t("settings.connections.replace")}>
          <span class="settings-row-description">{t("settings.connections.replace")}</span>
          <Button size="small" variant="contrast" onClick={confirmReplace}>{t("settings.connections.replaceConfirm")}</Button>
          <Button size="small" variant="ghost" onClick={() => state.send({ type: "cancel" })}>{t("settings.common.cancel")}</Button>
        </div>
      </Show>
      <Show when={waiting()}>
        {(current) => (
          <div class="settings-fields" role="status">
            <span class="settings-row-description">{t("settings.connections.waiting")}</span>
            <Show when={current().userCode}>{(code) => <code class="settings-code">{t("settings.connections.code", { code: code() })}</code>}</Show>
            <a class="settings-row-description" href={current().url} target="_blank" rel="noopener">{t("settings.connections.open")}</a>
          </div>
        )}
      </Show>
      <div class="settings-inline">
        <Show when={keyMethod()}>
          <Button type="submit" size="small" variant="contrast" disabled={busy()}>{t("settings.common.connect")}</Button>
        </Show>
        <Show when={oauthMethod()}>
          <Button type="button" size="small" variant={keyMethod() ? "neutral" : "contrast"} disabled={busy()} onClick={() => void submit("oauth", false)}>
            {t("settings.connections.oauth")}
          </Button>
        </Show>
        <Button type="button" size="small" variant="ghost" onClick={() => props.onCancel()}>{t("settings.common.cancel")}</Button>
      </div>
    </form>
  )
}
