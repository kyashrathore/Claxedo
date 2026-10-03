import { Match, Switch, type JSX } from "solid-js"
import { useErrorCopy, useTranslator } from "@/i18n"
import { FailureNotice } from "@/lib/failure"
import { DelayedLoading } from "@/ui"
import { shellDictionary } from "../i18n"
import type { LocalSessionResolution } from "../local-session-route"

export function LocalSessionRouteNotice(props: { readonly state: LocalSessionResolution; readonly onRetry: () => void }): JSX.Element {
  const t = useTranslator(shellDictionary)
  const copy = useErrorCopy()
  const failed = () => props.state.kind === "failed" ? copy(props.state.error) : undefined
  return (
    <Switch>
      <Match when={props.state.kind === "loading"}>
        <DelayedLoading><div role="status" class="p-4">{t("shell.loading")}</div></DelayedLoading>
      </Match>
      <Match when={failed()}>{(error) => <FailureNotice {...error()} retryLabel={error().retry} onRetry={props.onRetry} />}</Match>
    </Switch>
  )
}
