import { For, Match, Show, Switch, type JSX } from "solid-js"
import { openExternal } from "@/lib/external-link"
import { ClaxedoIcon as Icon, Button, RadioGroup, RadioItem, Spinner, TextField } from "@/ui"
import { CONTEXT_COPY, type ConnectFormInput, type OrganizationConnect, type ProviderConnect } from "../connect-form"
import type { ConnectAudience } from "../connect-state"
import { useAccountsText } from "../i18n"
import { ConnectCommand } from "./connect-command"

const AUDIENCES: readonly ConnectAudience[] = ["own", "org"]

function ExternalLink(props: { readonly href: string; readonly children: JSX.Element }) {
  return (
    <a href={props.href} target="_blank" rel="noreferrer" class="text-text-strong underline">
      {props.children}
    </a>
  )
}

function AudienceChoice(props: { readonly form: ProviderConnect; readonly organization: OrganizationConnect }) {
  const t = useAccountsText()
  return (
    <RadioGroup
      name="provider-connect-audience"
      label={t("provider.connect.audience.label")}
      value={props.form.store.audience}
      onChange={(value: string) => {
        const audience = AUDIENCES.find((candidate) => candidate === value)
        if (audience && audience !== props.form.store.audience) props.form.pickAudience(audience)
      }}
    >
      <RadioItem value="own" label={t("provider.connect.audience.own")} />
      <RadioItem value="org" label={t("provider.connect.audience.org")} description={t("provider.connect.audience.orgNote", { harnesses: props.organization.servedBy })} />
    </RadioGroup>
  )
}

function MethodChoice(props: { readonly form: ProviderConnect }) {
  const t = useAccountsText()
  const chosen = () => props.form.selected()
  return (
    <RadioGroup
      name="provider-connect-method"
      label={t("provider.connect.selectMethod", { vendor: props.form.vars().vendor ?? "" })}
      value={chosen() === undefined ? "" : String(chosen()?.index)}
      onChange={(value: string) => props.form.pickMethod(Number(value))}
    >
      <For each={props.form.options()}>
        {(option) => <RadioItem value={String(option.index)} label={props.form.methodCopy(option, "title")} description={props.form.methodCopy(option, "for")} />}
      </For>
    </RadioGroup>
  )
}

function MethodHow(props: { readonly form: ProviderConnect; readonly choosing: boolean }) {
  return (
    <Show when={props.form.selected()}>
      {(option) => (
        <div class="flex flex-col gap-1.5" data-method-type={option().type}>
          <Show when={!props.choosing}>
            <span class="text-12-regular text-text-weak">{props.form.methodCopy(option(), "title")}</span>
          </Show>
          <span class="text-13-regular text-text-base">{props.form.methodCopy(option(), "how")}</span>
        </div>
      )}
    </Show>
  )
}

function KeyPageLink(props: { readonly url: string }) {
  const t = useAccountsText()
  return (
    <Button class="w-auto" type="button" size="large" variant="neutral" data-action="provider-connect-open-key-page" onClick={() => openExternal(props.url)}>
      <span class="flex items-center gap-1.5">
        {t("provider.connect.method.openKeyPage")}
        <Icon name="open-external" size="small" />
      </span>
    </Button>
  )
}

function PasteFields(props: { readonly form: ProviderConnect; readonly reconnecting: boolean }) {
  const t = useAccountsText()
  const form = () => props.form
  const token = () => form().selected()?.type === "token"
  const vendor = () => form().vars().vendor ?? ""
  return (
    <div class="flex flex-col items-start gap-4" data-method={form().selected()?.type ?? "api"}>
      <Show when={form().selected()?.command}>{(command) => <ConnectCommand command={command()} />}</Show>
      <Show when={form().selected()?.spec.url}>{(url) => <KeyPageLink url={url()} />}</Show>
      <TextField
        autofocus
        type="text"
        label={token() ? t("provider.connect.token.label", { vendor: vendor() }) : t("provider.connect.apiKey.label", { vendor: vendor() })}
        placeholder={token() ? t("provider.connect.token.placeholder") : t("provider.connect.apiKey.placeholder")}
        name="apiKey"
        value={form().store.value}
        onChange={(value) => form().setValue(value)}
        invalid={!!form().store.error}
        error={form().store.error}
      />
      <Show when={!props.reconnecting}>
        <TextField
          type="text"
          label={t("provider.connect.label.label")}
          placeholder={t("provider.connect.label.placeholder")}
          name="accountLabel"
          value={form().store.label}
          onChange={(value) => form().setStore("label", value)}
        />
      </Show>
      <Show when={form().replaces()}>
        {(label) => (
          <p role="note" class="text-13-regular text-text-weak">
            {t(form().store.audience === "org" ? "provider.connect.replacesOrg" : "provider.connect.replaces", { label: label(), vendor: vendor() })}
          </p>
        )}
      </Show>
    </div>
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
    </div>
  )
}

function OAuthCode(props: { readonly form: ProviderConnect; readonly kind: ConnectFormInput["context"]["kind"] }) {
  const t = useAccountsText()
  const form = () => props.form
  return (
    <div class="flex flex-col items-start gap-4">
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
        onChange={(value) => form().setCode(value)}
        invalid={!!form().store.error}
        error={form().store.error}
      />
    </div>
  )
}

function ConnectStep(props: { readonly form: ProviderConnect; readonly input: ConnectFormInput }) {
  const t = useAccountsText()
  const form = () => props.form
  const kind = () => props.input.context.kind
  return (
    <Switch>
      <Match when={form().loadingMethods()}>
        <p class="flex items-center gap-2 text-13-regular text-text-base">
          <Spinner />
          <span>{t("provider.connect.methods.loading")}</span>
        </p>
      </Match>
      <Match when={form().methodsError()}>{(message) => <p role="alert" class="text-13-regular text-icon-critical-base">{message()}</p>}</Match>
      <Match when={form().options().length === 0}>
        <p class="text-13-regular text-text-base">{t("provider.connect.methods.unavailable", form().vars())}</p>
      </Match>
      <Match when={form().pastes()}>
        <PasteFields form={form()} reconnecting={props.input.credentialId !== undefined} />
      </Match>
      <Match when={form().store.state === "auto" && form().store.authorization}>
        <OAuthAuto form={form()} kind={kind()} />
      </Match>
      <Match when={form().store.state === "code" && form().store.authorization}>
        <OAuthCode form={form()} kind={kind()} />
      </Match>
      <Match when={form().selected()?.type === "oauth" && form().store.state === undefined}>
        <span class="text-12-regular text-text-weak">{t("provider.connect.oauth.hint")}</span>
      </Match>
    </Switch>
  )
}

export function ProviderConnectFields(props: { readonly form: ProviderConnect; readonly input: ConnectFormInput }) {
  const choosing = () => props.form.options().length > 1
  return (
    <div class="flex flex-col gap-5">
      <Show when={props.form.organization()}>{(organization) => <AudienceChoice form={props.form} organization={organization()} />}</Show>
      <Show when={choosing()}>
        <MethodChoice form={props.form} />
      </Show>
      <MethodHow form={props.form} choosing={choosing()} />
      <ConnectStep form={props.form} input={props.input} />
    </div>
  )
}
