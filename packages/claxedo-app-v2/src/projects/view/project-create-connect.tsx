import { createSignal, onCleanup, Show, type JSX } from "solid-js"
import { useServer, type Integration, type IntegrationFailure, type IntegrationGrant } from "@/server"
import { useProjectsText, type ProjectsText } from "../i18n"
import type { CreateFormLook } from "./project-create-repository"
import { Button } from "@/ui"

const FAILURE_KEYS = {
  exists: "projects.connect.failure.exists",
  rejected: "projects.connect.failure.rejected",
  unoffered: "projects.connect.failure.unoffered",
  unreachable: "projects.connect.failure.unreachable",
  expired: "projects.connect.failure.expired",
  denied: "projects.connect.failure.denied",
  gone: "projects.connect.failure.gone",
  timeout: "projects.connect.failure.timeout",
  failed: "projects.connect.failure.failed",
} as const satisfies Record<IntegrationFailure, string>

function createConnect(integration: () => Integration) {
  const server = useServer()
  const [secret, setSecret] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<IntegrationFailure>()
  const [grant, setGrant] = createSignal<IntegrationGrant>()
  let alive = true
  onCleanup(() => {
    alive = false
  })
  const awaitApproval = async (pending: IntegrationGrant) => {
    const outcome = await server.integrations.awaitGrant(pending, () => alive && grant()?.attemptId === pending.attemptId)
    if (outcome.kind === "abandoned") return
    setGrant(undefined)
    setBusy(false)
    if (outcome.kind === "failed") setFailure(outcome.reason)
  }
  const connect = async (method: "oauth" | "key") => {
    setBusy(true)
    setFailure(undefined)
    const outcome = await server.integrations.connect(integration().id, method === "oauth" ? { method } : { method, secret: secret() })
    if (outcome.kind === "authorize") {
      setGrant(outcome.grant)
      return void awaitApproval(outcome.grant)
    }
    setBusy(false)
    if (outcome.kind === "failed") return void setFailure(outcome.reason)
    setSecret("")
  }
  return { secret, setSecret, busy, failure, grant, connect }
}

type Connect = ReturnType<typeof createConnect>

function TokenForm(props: { look: CreateFormLook; integration: Integration; state: Connect }): JSX.Element {
  const t = useProjectsText()
  const prompt = () => props.integration.prompts.find((item) => item.secret) ?? props.integration.prompts[0]
  const text = () => (props.look.comfortable ? "text-13-regular" : "text-12-regular")
  const box = () => `${props.look.box} ${props.look.comfortable ? "text-14-regular" : "text-13-regular"}`
  return (
    <div class="flex flex-col gap-2">
      <input
        type={prompt()?.secret ? "password" : "text"}
        value={props.state.secret()}
        onInput={(event) => props.state.setSecret(event.currentTarget.value)}
        placeholder={prompt()?.placeholder ?? prompt()?.label}
        aria-label={prompt()?.label ?? t("projects.connect.token", { host: props.integration.name })}
        autocomplete="off"
        spellcheck={false}
        class={`${box()} w-full min-w-0 text-text-strong placeholder:text-text-weak/60 focus:outline-none focus:border-border-interactive-base`}
      />
      <div class="flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" size={props.look.comfortable ? "normal" : "small"} disabled={props.state.busy() || !props.state.secret().trim()} onClick={() => void props.state.connect("key")}>
          {props.state.busy() ? t("projects.connect.connecting") : t("projects.connect.withToken")}
        </Button>
        <Show when={prompt()?.createUrl}>
          {(href) => (
            <a href={href()} target="_blank" rel="noreferrer" class={`${text()} text-text-weak underline underline-offset-2 hover:text-text-strong`}>
              {t("projects.connect.createToken", { host: props.integration.name })}
            </a>
          )}
        </Show>
      </div>
    </div>
  )
}

function GrantWaiting(props: { look: CreateFormLook; grant: IntegrationGrant }): JSX.Element {
  const t = useProjectsText()
  return (
    <div class={`flex flex-col gap-1 ${props.look.comfortable ? "text-13-regular" : "text-12-regular"} text-text-base`}>
      <Show when={props.grant.userCode}>
        {(code) => (
          <span>
            {t("projects.connect.enter.before")}
            <span class="font-mono text-text-strong">
              {code()}
            </span>
            {t("projects.connect.enter.after")}
          </span>
        )}
      </Show>
      <a href={props.grant.url} target="_blank" rel="noreferrer" class="underline underline-offset-2 text-text-strong">
        {props.grant.url}
      </a>
      <span class="text-text-weak">{t("projects.connect.waiting")}</span>
    </div>
  )
}

function failureText(t: ProjectsText, reason: IntegrationFailure): string {
  return t(FAILURE_KEYS[reason])
}

export function ConnectCodeHost(props: { look: CreateFormLook; integration: Integration }): JSX.Element {
  const t = useProjectsText()
  const state = createConnect(() => props.integration)
  const usesOAuth = () => props.integration.methods.includes("oauth")
  return (
    <div class="flex flex-col gap-2">
      <span class={`${props.look.comfortable ? "text-13-regular" : "text-12-regular"} text-text-weak`}>{t("projects.connect.intro", { host: props.integration.name })}</span>
      <Show
        when={state.grant()}
        fallback={
          <Show when={usesOAuth()} fallback={<TokenForm look={props.look} integration={props.integration} state={state} />}>
            <Button type="button" variant="secondary" size={props.look.comfortable ? "normal" : "small"} class="self-start" disabled={state.busy()} onClick={() => void state.connect("oauth")}>
              {state.busy() ? t("projects.connect.connecting") : t("projects.connect.oauth", { host: props.integration.name })}
            </Button>
          </Show>
        }
      >
        {(pending) => <GrantWaiting look={props.look} grant={pending()} />}
      </Show>
      <Show when={state.failure()}>
        {(reason) => (
          <p class="text-12-regular text-icon-warning-base" role="alert">
            {failureText(t, reason())}
          </p>
        )}
      </Show>
    </div>
  )
}
