import { For, Match, Show, Switch, type JSX } from "solid-js"
import { ClaxedoIcon as Icon, Button, Spinner, TextField } from "@/ui"
import { CONTEXT_COPY, createProviderConnect, type ProviderConnect, type ConnectFormInput } from "../connect-form"
import { useAccountsText } from "../i18n"
import { ConnectCommand } from "./connect-command"
import { openExternal } from "@/lib/external-link"

function ExternalLink(props: { readonly href: string; readonly children: JSX.Element }) {
  return (
    <a href={props.href} target="_blank" rel="noreferrer" class="text-text-strong underline">
      {props.children}
    </a>
  )
}

function MethodPicker(props: { readonly form: ProviderConnect }) {
  const t = useAccountsText()
  return (
    <div class="flex flex-col gap-2">
      <span class="text-14-regular text-text-base">{t("provider.connect.selectMethod", { vendor: props.form.vars().vendor ?? "" })}</span>
      <div class="flex flex-col gap-1" role="radiogroup">
        <For each={props.form.options()}>
          {(option) => (
            <button
              type="button"
              role="radio"
              aria-checked={false}
              data-action="provider-connect-method"
              data-method-type={option.type}
              class="flex items-center justify-between gap-3 rounded-md border border-border-weak-base px-3 py-2.5 text-left transition-colors hover:border-border-strong-base hover:bg-surface-base-hover/35"
              onClick={() => props.form.pickMethod(option.index)}
            >
              <span class="flex min-w-0 flex-col gap-0.5">
                <span class="text-13-medium text-text-strong">{props.form.methodCopy(option, "title")}</span>
                <span class="text-12-regular text-text-weak">{props.form.methodCopy(option, "for")}</span>
              </span>
              <Icon name="chevron-right" size="small" class="shrink-0 text-icon-weak-base" />
            </button>
          )}
        </For>
      </div>
    </div>
  )
}

function ChosenMethod(props: { readonly form: ProviderConnect; readonly choosing: boolean }) {
  return (
    <Show when={props.form.selected()}>
      {(option) => (
        <div class="flex flex-col gap-1.5" data-method-type={option().type}>
          <Show when={props.choosing} fallback={<span class="text-12-regular text-text-weak">{props.form.methodCopy(option(), "title")}</span>}>
            <button
              type="button"
              class="-mx-1 flex w-fit items-center gap-1.5 rounded-md border-none bg-transparent px-1 py-0.5 text-12-regular text-text-weak transition-colors hover:text-text-base"
              data-action="provider-connect-change-method"
              onClick={() => props.form.pickMethod(-1)}
            >
              <Icon name="arrow-left" size="small" />
              <span>{props.form.methodCopy(option(), "title")}</span>
            </button>
          </Show>
          <span class="text-13-regular text-text-base">{props.form.methodCopy(option(), "how")}</span>
        </div>
      )}
    </Show>
  )
}

function PasteForm(props: { readonly form: ProviderConnect; readonly credentialId?: string }) {
  const t = useAccountsText()
  const form = () => props.form
  const token = () => form().selected()?.type === "token"
  const vendor = () => form().vars().vendor ?? ""
  return (
    <form onSubmit={(event) => void form().saveApiKey(event)} class="flex flex-col items-start gap-4" data-method={form().selected()?.type ?? "api"}>
      <Show when={form().selected()?.command}>{(command) => <ConnectCommand command={command()} />}</Show>
      <Show when={form().selected()?.spec.url}>
        {(url) => (
          <Button class="w-auto" type="button" size="large" variant="neutral" data-action="provider-connect-open-key-page" onClick={() => openExternal(url())}>
            <span class="flex items-center gap-1.5">
              {t("provider.connect.method.openKeyPage")}
              <Icon name="open-external" size="small" />
            </span>
          </Button>
        )}
      </Show>
      <TextField
        autofocus
        type="text"
        label={token() ? t("provider.connect.token.label", { vendor: vendor() }) : t("provider.connect.apiKey.label", { vendor: vendor() })}
        placeholder={token() ? t("provider.connect.token.placeholder") : t("provider.connect.apiKey.placeholder")}
        name="apiKey"
        value={form().store.value}
        onChange={(value) => form().setStore("value", value)}
        invalid={!!form().store.error}
        error={form().store.error}
      />
      <Show when={!props.credentialId && !form().hosted()}>
        <TextField
          type="text"
          label={t("provider.connect.label.label")}
          placeholder={t("provider.connect.label.placeholder")}
          name="accountLabel"
          value={form().store.label}
          onChange={(value) => form().setStore("label", value)}
        />
      </Show>
      <Button class="w-auto" type="submit" size="large" variant="contrast" disabled={form().store.saving}>
        {t("common.continue")}
      </Button>
    </form>
  )
}

function OAuthAuto(props: { readonly form: ProviderConnect; readonly kind: ConnectFormInput["context"]["kind"] }) {
  const t = useAccountsText()
  const authorization = () => props.form.store.authorization
  return (
    <div class="flex flex-col gap-4 text-14-regular text-text-base">
      <div>
        {t("provider.connect.oauth.auto.visit.prefix")}
        <ExternalLink href={authorization()?.url ?? ""}>{t("provider.connect.oauth.auto.visit.link")}</ExternalLink>
        {t(CONTEXT_COPY.autoVisitSuffix[props.kind], props.form.vars())}
      </div>
      <TextField label={t("provider.connect.oauth.auto.confirmationCode")} value={(authorization()?.instructions ?? "").replace(/^Enter code:\s*/i, "")} readOnly copyable />
      <div class="flex items-center gap-2">
        <Spinner />
        <span>{t("provider.connect.status.waiting")}</span>
      </div>
      <Show when={props.form.store.error}>
        <div class="text-14-regular text-icon-critical-base">{props.form.store.error}</div>
      </Show>
    </div>
  )
}

function OAuthCode(props: { readonly form: ProviderConnect; readonly kind: ConnectFormInput["context"]["kind"] }) {
  const t = useAccountsText()
  const form = () => props.form
  return (
    <form
      class="flex flex-col items-start gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        void form().finishOAuth(form().store.code.trim())
      }}
    >
      <div class="text-14-regular text-text-base">
        {t("provider.connect.oauth.code.visit.prefix")}
        <ExternalLink href={form().store.authorization?.url ?? ""}>{t("provider.connect.oauth.code.visit.link")}</ExternalLink>
        {t(CONTEXT_COPY.codeVisitSuffix[props.kind], form().vars())}
      </div>
      <TextField
        autofocus
        type="text"
        label={t("provider.connect.oauth.code.label", { method: form().selected()?.label ?? "" })}
        placeholder={t("provider.connect.oauth.code.placeholder")}
        value={form().store.code}
        onChange={(value) => form().setStore("code", value)}
        invalid={!!form().store.error}
        error={form().store.error}
      />
      <Button class="w-auto" type="submit" size="large" variant="contrast" disabled={form().store.saving}>
        {t("common.continue")}
      </Button>
    </form>
  )
}

function OAuthStart(props: { readonly form: ProviderConnect }) {
  const t = useAccountsText()
  return (
    <div class="flex items-center gap-3">
      <Button
        class="w-auto"
        type="button"
        size="large"
        variant="contrast"
        disabled={props.form.store.saving}
        data-action="provider-connect-oauth-start"
        onClick={() => {
          const option = props.form.selected()
          if (option) void props.form.startOAuth(option.index)
        }}
      >
        {t("provider.connect.oauth.start")}
      </Button>
      <span class="text-12-regular text-text-weak">{t("provider.connect.oauth.hint")}</span>
    </div>
  )
}

function ConnectStep(props: { readonly form: ProviderConnect; readonly input: ConnectFormInput }) {
  const t = useAccountsText()
  const form = () => props.form
  const kind = () => props.input.context.kind
  return (
    <Switch>
      <Match when={form().options().length === 0}>
        <p class="text-13-regular text-text-base">{t("provider.connect.hosted.signsElsewhere", form().vars())}</p>
      </Match>
      <Match when={form().pastes()}>
        <PasteForm form={form()} {...(props.input.credentialId ? { credentialId: props.input.credentialId } : {})} />
      </Match>
      <Match when={form().store.state === "pending"}>
        <div class="text-14-regular text-text-base flex items-center gap-2">
          <Spinner />
          <span>{t("provider.connect.status.inProgress")}</span>
        </div>
      </Match>
      <Match when={form().store.state === "auto" && form().store.authorization}>
        <OAuthAuto form={form()} kind={kind()} />
      </Match>
      <Match when={form().store.state === "code" && form().store.authorization}>
        <OAuthCode form={form()} kind={kind()} />
      </Match>
      <Match when={form().store.state === "error"}>
        <div class="text-14-regular text-icon-critical-base">{form().store.error}</div>
      </Match>
      <Match when={form().selected()?.type === "oauth"}>
        <OAuthStart form={form()} />
      </Match>
    </Switch>
  )
}

export function ProviderConnectForm(props: ConnectFormInput) {
  const form = createProviderConnect(props)
  const choosing = () => form.options().length > 1
  const picking = () => choosing() && form.selected() === undefined
  return (
    <div class="flex flex-col gap-5">
      <Show when={picking()}>
        <MethodPicker form={form} />
      </Show>
      <Show when={!picking()}>
        <ChosenMethod form={form} choosing={choosing()} />
      </Show>
      <ConnectStep form={form} input={props} />
    </div>
  )
}
